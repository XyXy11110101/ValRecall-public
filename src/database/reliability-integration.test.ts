// @vitest-environment node
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValRecallRepository } from './repository';
import { DraftRepository } from './drafts';
import { WalletRepository } from './wallet';
import { editState } from './edit-commit';
import { FsrsService } from '../fsrs';
import { STORE_NAMES } from './migrations';
import { contentFingerprint, type IntakeSelection } from '../intake/package';
import { transactionComplete } from './idb';

const now = new Date('2026-10-21T12:00:00Z');
const item = {
  id: 'question',
  title: '中文 / English',
  itemType: 'Understand' as const,
  recallPrompt: 'Why?',
  coreLesson: 'Because',
  referenceAnswer: 'Because',
  fsrsCard: new FsrsService({ clock: () => now }).createInitialCard(),
};
const selection: IntakeSelection = {
  package: {
    format: 'valrecall-intake',
    version: 1,
    packageId: 'packet',
    records: [
      {
        id: 'record',
        title: '来源',
        excerpt: '原文\nEnglish',
        thought: '',
        summary: '',
        aiAdditions: '',
        bookTitle: '书',
        location: '页',
        questions: [
          { id: 'q1', prompt: 'Why?', answer: 'Because', needsConfirmation: false },
          { id: 'q2', prompt: 'How?', answer: 'Details', needsConfirmation: false },
        ],
      },
    ],
  },
  categories: {},
};
function fixture() {
  const repository = new ValRecallRepository({
    indexedDBFactory: new IDBFactory(),
    databaseName: 'reliability',
    clock: () => now,
  });
  return {
    repository,
    drafts: new DraftRepository(repository, () => now),
    wallet: new WalletRepository(repository),
  };
}
afterEach(() => vi.restoreAllMocks());

describe('reliability boundaries across repository services', () => {
  it('rolls back an image, item, receipt and draft consumption on an actual wallet write fault', async () => {
    const { repository, drafts, wallet } = fixture();
    await wallet.ensureWallet();
    const draft = await drafts.save(
      {
        id: 'op',
        scope: 'manual',
        summary: 'image',
        payload: { selected: ['q1'], image: new Blob(['png'], { type: 'image/png' }) },
      },
      0,
    );
    const image = { blob: new Blob(['png'], { type: 'image/png' }), width: 1, height: 1 };
    const commit = { id: 'op', kind: 'manual' as const, fingerprint: 'fixed', draft };
    const original = IDBObjectStore.prototype.put;
    const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (this.name === STORE_NAMES.wallet)
        throw new DOMException('Synthetic full disk', 'QuotaExceededError');
      return original.apply(this, args);
    });
    await expect(repository.createImageItem(item, image, commit)).rejects.toThrow();
    fault.mockRestore();
    const failed = await repository.exportData();
    expect(failed.items).toEqual([]);
    expect(failed.screenshots).toEqual([]);
    expect(failed.learningReceipts).toEqual([]);
    expect(await drafts.list('manual')).toHaveLength(1);
    expect((await wallet.load()).balance).toBe(0);
    await Promise.all([
      repository.createImageItem(item, image, commit),
      repository.createImageItem(item, image, commit),
    ]);
    const saved = await repository.exportData();
    expect(saved.items).toHaveLength(1);
    expect(saved.screenshots).toHaveLength(1);
    expect(saved.learningReceipts).toHaveLength(1);
    expect((await wallet.load()).balance).toBe(3);
    expect(await drafts.list('manual')).toEqual([]);
  });

  it('commits a selected intake batch and its original reward exactly once after response loss', async () => {
    const { repository, drafts, wallet } = fixture();
    const draft = await drafts.save(
      {
        id: 'intake-op',
        scope: 'intake',
        summary: '两题',
        payload: { packet: JSON.stringify(selection), selected: ['q1', 'q2'] },
      },
      0,
    );
    const commit = { id: draft.id, fingerprint: await contentFingerprint(selection), draft };
    const first = await repository.receiveAtomicIntake(selection, 'standard', commit);
    expect(first.questions).toBe(2);
    expect(first.rewardAmount).toBe(9);
    expect(await repository.receiveAtomicIntake(selection, 'standard', commit)).toEqual(first);
    expect((await wallet.load()).balance).toBe(9);
    expect(await drafts.list('intake')).toEqual([]);
    const repeated = await repository.receiveAtomicIntake(selection, 'standard', {
      id: 'new-request',
      fingerprint: commit.fingerprint,
    });
    expect(repeated.questions).toBe(0);
    expect(repeated.rewardAmount).toBe(0);
    expect((await wallet.load()).balance).toBe(9);
  });

  it('keeps the whole intake and its choices on a stale draft, and preserves historical unknown rewards', async () => {
    const { repository, drafts, wallet } = fixture();
    const draft = await drafts.save(
      { id: 'intake-op', scope: 'intake', summary: '两题', payload: ['q1', 'q2'] },
      0,
    );
    await drafts.save({ ...draft, payload: ['q1'] }, draft.revision);
    await expect(
      repository.receiveAtomicIntake(selection, 'standard', {
        id: draft.id,
        fingerprint: 'fixed',
        draft,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await repository.listItems()).toEqual([]);
    expect((await wallet.load()).balance).toBe(0);
    const legacy = await repository.receiveIntake(selection, 'standard');
    expect(legacy.questions).toBe(2);
    await repository.receiveAtomicIntake(selection, 'standard', {
      id: 'fresh',
      fingerprint: 'fixed',
    });
    const backup = await repository.exportData();
    expect(backup.intakeReceipts.every((row) => row.reward === 'attempted')).toBe(true);
    expect((await wallet.load()).balance).toBe(0);
  });

  it('protects edited learning content from stale windows, even with an identical clock', async () => {
    const { repository, drafts } = fixture();
    const original = await repository.createTextItem(item);
    const draft = await drafts.save(
      { id: 'edit', scope: 'library:question', summary: '编辑', payload: 'keep me' },
      0,
    );
    await repository.updateItem(
      item.id,
      { coreLesson: 'Other window' },
      { expectedState: editState(original) },
    );
    await expect(
      repository.updateItem(
        item.id,
        { coreLesson: 'Mine' },
        { expectedState: editState(original), draft },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await repository.getItem(item.id))?.coreLesson).toBe('Other window');
    expect(await drafts.list('library:question')).toHaveLength(1);
    await repository.deleteItem(item.id);
    await expect(
      repository.updateItem(
        item.id,
        { coreLesson: 'Mine' },
        { expectedState: editState(original), draft },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await drafts.list('library:question')).toHaveLength(1);
  });

  it('allows editing a reviewed item without recomputing its schedule or awarding money', async () => {
    const { repository, drafts, wallet } = fixture();
    const original = await repository.createTextItem(item);
    await new FsrsService({ repository, clock: () => now }).reviewItem(original.id, 'Good', now);
    const current = (await repository.getItem(original.id))!;
    const draft = await drafts.save(
      { id: 'edit', scope: 'library:question', summary: '编辑', payload: 'New' },
      0,
    );
    await repository.updateItem(
      current.id,
      { coreLesson: 'New' },
      { expectedState: editState(current), draft },
    );
    const updated = await repository.getItem(current.id);
    expect(updated?.reviewHistory).toEqual(current.reviewHistory);
    expect(updated?.fsrsCard).toEqual(current.fsrsCard);
    expect(await drafts.list('library:question')).toEqual([]);
    expect((await wallet.load()).balance).toBe(0);
  });

  it('aborts task creation and editing if draft consumption fails', async () => {
    const { repository, drafts } = fixture();
    const values = {
      id: 'task',
      title: 'Do it',
      kind: 'routine' as const,
      recurrence: 'daily' as const,
    };
    const draft = await drafts.save(
      { id: 'task-draft', scope: 'task-create', summary: 'Do', payload: values },
      0,
    );
    await drafts.save({ ...draft, payload: 'changed' }, draft.revision);
    await expect(repository.createTask(values, draft)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await repository.getTask('task')).toBeUndefined();
    const task = await repository.createTask(values);
    const tx = (await repository.open()).transaction(STORE_NAMES.dailyTasks, 'readwrite');
    const done = transactionComplete(tx);
    tx.objectStore(STORE_NAMES.dailyTasks).put({ ...task, title: 'External' });
    await done;
    await expect(
      repository.updateTask(task.id, { title: 'Mine' }, { expectedState: editState(task), draft }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await repository.getTask(task.id))?.title).toBe('External');
  });
});
