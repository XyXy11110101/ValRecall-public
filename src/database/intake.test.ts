// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { contentFingerprint, intakeQuestionKey, type IntakeSelection } from '../intake/package';
import { saveIntake } from '../intake/save-intake';
import { FsrsService } from '../fsrs';
import { noteContent, type NoteRecord } from '../models/note';
import type { IntakeReceipt } from './intake-types';
import { ValRecallRepository } from './repository';
import { DATABASE_VERSION, runMigrations, STORE_NAMES } from './migrations';
import { transactionComplete as idbDone, requestResult as idbRequest } from './idb';

const now = new Date('2026-10-01T12:00:00Z');
function selection(questions = 1): IntakeSelection {
  return {
    package: {
      format: 'valrecall-intake',
      version: 1,
      packageId: 'test-package',
      records: [
        {
          id: 'r1',
          title: 'An idea',
          excerpt: '',
          thought: 'My thought, not a quote.',
          summary: 'Organized thought',
          aiAdditions: 'Unverified explanation',
          bookTitle: '',
          location: '',
          questions: Array.from({ length: questions }, (_, i) => ({
            id: `q${i}`,
            prompt: `Explain concept ${i}?`,
            answer: `Answer ${i}`,
            needsConfirmation: false,
          })),
        },
      ],
    },
    categories: {},
  };
}

describe('atomic question intake with legacy source compatibility', () => {
  let factory: IDBFactory;
  let repository: ValRecallRepository;
  let seq: number;
  beforeEach(() => {
    factory = new IDBFactory();
    seq = 0;
    repository = new ValRecallRepository({
      indexedDBFactory: factory,
      databaseName: 'intake-test',
      clock: () => now,
      idGenerator: () => `new-${++seq}`,
    });
  });
  async function seedLegacy(selected = selection()) {
    const record = selected.package.records[0]!;
    const content = noteContent(record);
    const note: NoteRecord = {
      ...content,
      schemaVersion: 1,
      id: 'legacy-note',
      categoryId: selected.categories[record.id] ?? null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const receipts: IntakeReceipt[] = [
      {
        schemaVersion: 1,
        id: JSON.stringify(['note', selected.package.packageId, record.id]),
        kind: 'note',
        fingerprint: await contentFingerprint(['note', content]),
        targetId: note.id,
        processedAt: now.toISOString(),
        reward: 'awarded',
      },
    ];
    for (const question of record.questions) {
      const item = await repository.createTextItem({
        title: question.prompt,
        itemType: 'Understand',
        coreLesson: question.answer,
        recallPrompt: question.prompt,
        referenceAnswer: question.answer,
        categoryId: note.categoryId,
        noteSource: { ...content, schemaVersion: 1, noteId: note.id },
        fsrsCard: new FsrsService({ clock: () => now }).createInitialCard(),
      });
      receipts.push({
        schemaVersion: 1,
        id: JSON.stringify(['question', selected.package.packageId, record.id, question.id]),
        kind: 'question',
        fingerprint: await contentFingerprint([
          'question',
          content,
          question.prompt.trim(),
          question.answer.trim(),
        ]),
        targetId: item.id,
        processedAt: now.toISOString(),
        reward: 'awarded',
      });
    }
    // Seed the historical stores directly: the current intake deliberately cannot
    // create Notes or their receipts, including note-only legacy packages.
    await repository.exportData();
    const database = await idbRequest(factory.open('intake-test'));
    const tx = database.transaction([STORE_NAMES.notes, STORE_NAMES.intakeReceipts], 'readwrite');
    const done = idbDone(tx);
    tx.objectStore(STORE_NAMES.notes).add(note);
    for (const receipt of receipts) tx.objectStore(STORE_NAMES.intakeReceipts).add(receipt);
    await done;
    database.close();
    return note;
  }
  it('creates only three scheduled questions with complete source snapshots and no screenshot or review', async () => {
    const preview = await repository.previewIntake(selection(3));
    expect(preview).toMatchObject({ notes: 0, questions: 3 });
    expect(await repository.listNotes()).toEqual([]);
    const result = await repository.receiveIntake(selection(3), 'standard');
    expect(result).toMatchObject({ notes: 0, questions: 3 });
    const backup = await repository.exportData();
    expect(backup.notes).toEqual([]);
    expect(backup.items).toHaveLength(3);
    expect(backup.screenshots).toEqual([]);
    expect(backup.reviews).toEqual([]);
    expect(backup.intakeReceipts).toHaveLength(3);
    expect(
      backup.intakeReceipts.every((row) => row.kind === 'question' && row.reward === 'attempted'),
    ).toBe(true);
    expect(backup.items[0]).toMatchObject({
      sourceType: 'text',
      noteSource: {
        ...noteContent(selection().package.records[0]!),
        noteId: expect.stringMatching(/^source:[a-f0-9]{64}$/u),
      },
      fsrsCard: { due: now.toISOString(), reps: 0 },
    });
  });
  it('legacy material without questions writes nothing and never triggers rewards or check-in', async () => {
    const before = await repository.exportData();
    const reward = vi.fn();
    const selected = selection(0);
    selected.categories.r1 = 'removed-category';
    const saved = await saveIntake(selected, 'standard', {
      receive: repository.receiveIntake.bind(repository),
      finish: repository.finishIntakeReward.bind(repository),
      reward,
    });
    expect(saved).toMatchObject({
      notes: 0,
      questions: 0,
      entries: [],
      rewardReceiptIds: [],
      rewardAmount: 0,
    });
    expect(saved.warning).toContain('没有可保存的题目');
    expect(reward).not.toHaveBeenCalled();
    expect(await repository.exportData()).toEqual(before);
    expect(await repository.listItems()).toEqual([]);
    expect(await repository.listNotes()).toEqual([]);
    expect(await repository.getLearningStatistics(30, now)).toMatchObject({
      reviewCount: 0,
      newItems: 0,
    });
  });
  it('skips exact content even with changed package and record IDs, and keeps deletion receipts', async () => {
    await repository.receiveIntake(selection(), 'standard');
    const second = selection();
    second.package.packageId = 'different-package';
    second.package.records[0]!.id = 'changed-id';
    second.package.records[0]!.questions[0]!.id = 'different-q';
    const repeat = await repository.receiveIntake(second, 'standard');
    expect(repeat).toMatchObject({ notes: 0, questions: 0, rewardReceiptIds: [] });
    const item = (await repository.listItems())[0]!;
    await repository.deleteItem(item.id);
    expect(await repository.receiveIntake(selection(), 'standard')).toMatchObject({
      notes: 0,
      questions: 0,
    });
    expect(await repository.listNotes()).toEqual([]);
    expect(await repository.listItems()).toEqual([]);
  });
  it('recognizes historical question receipts without changing or rewarding legacy notes', async () => {
    await seedLegacy();
    const before = await repository.exportData();
    const reward = vi.fn();
    const dependencies = {
      receive: repository.receiveIntake.bind(repository),
      finish: repository.finishIntakeReward.bind(repository),
      reward,
    };
    expect(await saveIntake(selection(), 'standard', dependencies)).toMatchObject({
      notes: 0,
      questions: 0,
      rewardAmount: 0,
    });
    const moved = selection();
    moved.package.packageId = 'another-package';
    moved.package.records[0]!.id = 'another-record';
    moved.package.records[0]!.questions[0]!.id = 'another-question';
    expect(await saveIntake(moved, 'standard', dependencies)).toMatchObject({
      notes: 0,
      questions: 0,
      rewardAmount: 0,
    });
    const item = (await repository.listItems())[0]!;
    await repository.deleteItem(item.id);
    const deleted = await saveIntake(selection(), 'standard', dependencies);
    expect(deleted.entries).toEqual([
      expect.objectContaining({ kind: 'question', status: 'duplicate', deleted: true }),
    ]);
    expect(await repository.listItems()).toEqual([]);
    const after = await repository.exportData();
    expect(after.notes).toEqual(before.notes);
    expect(after.intakeReceipts.filter((row) => row.kind === 'note')).toEqual(
      before.intakeReceipts.filter((row) => row.kind === 'note'),
    );
    expect(reward).not.toHaveBeenCalled();
  });
  it('adds questions from a legacy source even after its note was deleted, without restoring the note', async () => {
    const note = await seedLegacy();
    const original = (await repository.listItems())[0]!;
    await repository.deleteNote(note.id);
    const saved = await repository.receiveIntake(selection(2), 'standard');
    expect(saved).toMatchObject({ notes: 0, questions: 1 });
    expect(saved.rewardReceiptIds).toEqual([
      JSON.stringify(['question', 'test-package', 'r1', 'q1']),
    ]);
    expect(
      (await repository.listItems()).every(
        (item) => item.sourceType === 'text' && item.noteSource?.noteId === note.id,
      ),
    ).toBe(true);
    expect(await repository.getItem(original.id)).toEqual(original);
    expect(await repository.listNotes()).toEqual([]);
    expect(
      (await repository.exportData()).intakeReceipts.filter((row) => row.kind === 'note'),
    ).toHaveLength(1);
  });
  it('does not let legacy note identity conflicts block an independent new question', async () => {
    const note = await seedLegacy(selection(0));
    const selected = selection();
    selected.package.records[0]!.thought = 'A different source snapshot';
    expect(await repository.receiveIntake(selected, 'standard')).toMatchObject({
      notes: 0,
      questions: 1,
    });
    const item = (await repository.listItems())[0]!;
    expect(item).toMatchObject({
      noteSource: {
        thought: 'A different source snapshot',
        noteId: expect.stringMatching(/^source:/u),
      },
    });
    expect(await repository.getNote(note.id)).toEqual(note);
  });
  it('ignores questionless material in a mixed package without affecting selected questions', async () => {
    const selected = selection();
    selected.package.records.push({ ...selected.package.records[0]!, id: 'unused', questions: [] });
    selected.categories.unused = 'no-longer-exists';
    const result = await repository.receiveIntake(selected, 'standard');
    expect(result).toMatchObject({ notes: 0, questions: 1 });
    expect(result.entries).toHaveLength(1);
    expect((await repository.exportData()).intakeReceipts).toHaveLength(1);
  });
  it('same identity changed content conflicts atomically, including another new record', async () => {
    await repository.receiveIntake(selection(), 'standard');
    const changed = selection();
    changed.package.records[0]!.questions[0]!.answer = 'Changed answer';
    changed.package.records.push({
      ...changed.package.records[0]!,
      id: 'r2',
      thought: 'Unrelated new note',
    });
    const preview = await repository.previewIntake(changed);
    expect(preview.entries.some((entry) => entry.status === 'conflict')).toBe(true);
    await expect(repository.receiveIntake(changed, 'standard')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await repository.listNotes()).toEqual([]);
    expect(await repository.listItems()).toHaveLength(1);
  });
  it('serializes concurrent windows and permits only one reward attempt', async () => {
    const other = new ValRecallRepository({
      indexedDBFactory: factory,
      databaseName: 'intake-test',
      clock: () => now,
    });
    const results = await Promise.all([
      repository.receiveIntake(selection(), 'standard'),
      other.receiveIntake(selection(), 'standard'),
    ]);
    expect(results.map((r) => r.questions).sort()).toEqual([0, 1]);
    expect(results.reduce((sum, r) => sum + r.rewardReceiptIds.length, 0)).toBe(1);
  });
  it('rolls back native constraint failures instead of leaving partial questions or receipts', async () => {
    const brokenIds = new ValRecallRepository({
      indexedDBFactory: factory,
      databaseName: 'intake-test',
      clock: () => now,
      idGenerator: () => 'collision',
    });
    await expect(brokenIds.receiveIntake(selection(2), 'standard')).rejects.toMatchObject({
      code: 'TRANSACTION_FAILED',
    });
    const backup = await repository.exportData();
    expect(backup.notes).toEqual([]);
    expect(backup.items).toEqual([]);
    expect(backup.intakeReceipts).toEqual([]);
  });
  it('rejects blank/unconfirmed questions and missing categories before persistence', async () => {
    const selected = selection();
    selected.package.records[0]!.questions[0]!.needsConfirmation = true;
    await expect(repository.receiveIntake(selected, 'standard')).rejects.toMatchObject({
      code: 'INVALID_DATA',
    });
    selected.package.records[0]!.questions[0]!.needsConfirmation = false;
    selected.categories.r1 = 'missing';
    await expect(repository.receiveIntake(selected, 'standard')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await repository.listNotes()).toEqual([]);
  });
  it('saves the package category on each question and lets a question choice win, including 未分类', async () => {
    const reading = await repository.createCategory('Reading');
    const work = await repository.createCategory('Work');
    const selected = selection(4);
    // Legacy record entry: used by questions without their own choice.
    selected.categories.r1 = reading.id;
    selected.questionCategories = {
      [intakeQuestionKey('r1', 'q0')]: work.id,
      [intakeQuestionKey('r1', 'q1')]: null,
      [intakeQuestionKey('r1', 'q3')]: reading.id,
      // Keys for questions that are not in the selection are ignored, unchecked.
      [intakeQuestionKey('r1', 'not-selected')]: 'no-such-category',
      [intakeQuestionKey('other-record', 'q0')]: 'no-such-category',
    };
    expect(await repository.previewIntake(selected)).toMatchObject({ questions: 4 });
    expect(await repository.receiveIntake(selected, 'standard')).toMatchObject({ questions: 4 });
    const byPrompt = new Map(
      (await repository.listItems()).map((item) => [item.recallPrompt, item.categoryId]),
    );
    expect([0, 1, 2, 3].map((index) => byPrompt.get(`Explain concept ${index}?`))).toEqual([
      work.id,
      null,
      reading.id,
      reading.id,
    ]);
  });
  it('uses per-question categories alone when no legacy record category is given', async () => {
    const work = await repository.createCategory('Work');
    const selected = selection(2);
    selected.questionCategories = { [intakeQuestionKey('r1', 'q1')]: work.id };
    await repository.receiveIntake(selected, 'standard');
    const byPrompt = new Map(
      (await repository.listItems()).map((item) => [item.recallPrompt, item.categoryId]),
    );
    expect(byPrompt.get('Explain concept 0?')).toBeNull();
    expect(byPrompt.get('Explain concept 1?')).toBe(work.id);
  });
  it('rejects malformed or missing per-question categories before writing anything', async () => {
    const selected = selection(2);
    selected.questionCategories = {
      [intakeQuestionKey('r1', 'q0')]: 7 as unknown as string,
    };
    await expect(repository.previewIntake(selected)).rejects.toMatchObject({
      code: 'INVALID_DATA',
    });
    // An empty id is malformed, not a missing category.
    selected.questionCategories = { [intakeQuestionKey('r1', 'q0')]: '' };
    await expect(repository.previewIntake(selected)).rejects.toMatchObject({
      code: 'INVALID_DATA',
    });
    selected.questionCategories = ['c'] as unknown as Record<string, string | null>;
    await expect(repository.receiveIntake(selected, 'standard')).rejects.toMatchObject({
      code: 'INVALID_DATA',
    });
    delete selected.questionCategories;
    selected.categories = null as unknown as Record<string, string | null>;
    await expect(repository.receiveIntake(selected, 'standard')).rejects.toMatchObject({
      code: 'INVALID_DATA',
    });
    selected.categories = {};
    selected.questionCategories = { [intakeQuestionKey('r1', 'q1')]: 'deleted-category' };
    await expect(repository.receiveIntake(selected, 'standard')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await repository.listItems()).toEqual([]);
    expect((await repository.exportData()).intakeReceipts).toEqual([]);
  });
  it('editing notes does not change snapshots; adding a later question rewards only that question', async () => {
    const note = await seedLegacy();
    const edited = await repository.updateNote({ ...note, title: 'Edited title' });
    expect((await repository.listItems())[0]).toMatchObject({ noteSource: { title: 'An idea' } });
    const followup = selection();
    Object.assign(followup.package.records[0]!, edited, { id: note.id });
    // Only transport fields are carried to a new question package.
    followup.package.records[0] = {
      ...noteContent(edited),
      id: note.id,
      questions: [
        {
          id: 'new-q',
          prompt: 'A new question?',
          answer: 'A new answer',
          needsConfirmation: false,
        },
      ],
    };
    expect(await repository.receiveIntake(followup, 'standard')).toMatchObject({
      notes: 0,
      questions: 1,
    });
    expect(await repository.listNotes()).toHaveLength(1);
  });
  it('category merge/delete includes notes without mutating source snapshots', async () => {
    const first = await repository.createCategory('First');
    const second = await repository.createCategory('Second');
    const selected = selection();
    selected.categories.r1 = first.id;
    await seedLegacy(selected);
    expect(await repository.mergeCategory(first.id, second.id)).toBe(2);
    expect((await repository.listNotes())[0]?.categoryId).toBe(second.id);
    await repository.deleteCategory(second.id);
    expect((await repository.listNotes())[0]?.categoryId).toBeNull();
  });
  it('rejects stale note edits even with a fixed millisecond clock', async () => {
    const original = await seedLegacy(selection(0));
    await repository.updateNote({ ...original, thought: 'First editor' });
    await expect(
      repository.updateNote({ ...original, thought: 'Stale second editor' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await repository.getNote(original.id))?.thought).toBe('First editor');
  });
  it('round-trips v8 including tombstones and retains local reward state during merge', async () => {
    const result = await repository.receiveIntake(selection(), 'standard');
    const backup = await repository.exportData();
    await repository.finishIntakeReward(result.rewardReceiptIds, 'awarded');
    await repository.importData(backup, 'merge');
    expect(
      (await repository.exportData()).intakeReceipts.every((row) => row.reward === 'awarded'),
    ).toBe(true);
    await repository.clearAllData();
    expect(await repository.listNotes()).toEqual([]);
    await repository.importData(backup, 'replace');
    expect(await repository.receiveIntake(selection(), 'standard')).toMatchObject({
      notes: 0,
      questions: 0,
    });
  });
  it('round-trips historical notes, source snapshots and receipts without recreating or rewarding notes', async () => {
    await seedLegacy(selection(2));
    const legacy = await repository.exportData();
    await repository.clearAllData();
    await repository.importData(legacy, 'replace');
    const restored = await repository.exportData();
    expect(restored).toMatchObject({
      notes: legacy.notes,
      items: legacy.items,
      intakeReceipts: legacy.intakeReceipts,
    });
    expect(await repository.receiveIntake(selection(2), 'standard')).toMatchObject({
      notes: 0,
      questions: 0,
      rewardReceiptIds: [],
    });
    expect(await repository.exportData()).toEqual(restored);
  });
  it('reads v7 with no notes and upgrades a v2 database without deleting its metadata', async () => {
    const open = factory.open('legacy', 2);
    open.onupgradeneeded = () => runMigrations(open.result, open.transaction!, 0, 2);
    const database = await idbRequest(open);
    const tx = database.transaction(STORE_NAMES.meta, 'readwrite');
    const done = idbDone(tx);
    tx.objectStore(STORE_NAMES.meta).put({
      key: 'kept',
      value: 'legacy',
      updatedAt: now.toISOString(),
    });
    await done;
    database.close();
    const migrated = new ValRecallRepository({ indexedDBFactory: factory, databaseName: 'legacy' });
    expect(await migrated.getMeta('kept')).toBe('legacy');
    expect(await migrated.getMeta('databaseSchemaVersion')).toBe(DATABASE_VERSION);
    const backup = await migrated.exportData();
    const { notes: _notes, intakeReceipts: _receipts, ...legacy } = backup;
    void _notes;
    void _receipts;
    await expect(migrated.importData({ ...legacy, schemaVersion: 7 })).resolves.toMatchObject({
      notes: 0,
    });
  });
  it('reward failure retains content and retry cannot repay', async () => {
    const reward = vi.fn().mockRejectedValue(new Error('response lost'));
    const dependencies = {
      receive: repository.receiveIntake.bind(repository),
      finish: repository.finishIntakeReward.bind(repository),
      reward,
    };
    const first = await saveIntake(selection(3), 'standard', dependencies);
    expect(first.warning).toContain('奖励未能确认');
    expect(first.rewardAmount).toBeNull();
    expect(reward).toHaveBeenCalledWith(0, 3);
    await saveIntake(selection(3), 'standard', dependencies);
    expect(reward).toHaveBeenCalledTimes(1);
  });
});
