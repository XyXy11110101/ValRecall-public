// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ValRecallRepository } from '../database';
import { WalletRepository } from '../database/wallet';
import { transactionComplete } from '../database/idb';
import { STORE_NAMES } from '../database/migrations';
import { newManualDraft, type ManualQuestionDraft } from './manual-draft';
import { saveManualQuestion, type ManualSaveDependencies } from './save-manual';

const now = new Date('2026-10-11T12:00:00Z');
function draft(): ManualQuestionDraft {
  return {
    ...newManualDraft(),
    title: 'A cue',
    recallPrompt: '  Why does this work?  ',
    coreLesson: 'Because evidence supports it.',
    tags: 'reason, example',
  };
}
describe('shared manual question persistence', () => {
  let repository: ValRecallRepository;
  let deps: ManualSaveDependencies;
  beforeEach(() => {
    repository = new ValRecallRepository({
      indexedDBFactory: new IDBFactory(),
      databaseName: 'manual',
      clock: () => now,
    });
    deps = {
      repository,
      clock: () => now,
    };
  });
  it('keeps authored prompt spacing, canonical answer and manual +3 without check-in', async () => {
    const value = draft();
    const saved = await saveManualQuestion(value, 'standard', deps);
    expect(saved.item).toMatchObject({
      id: value.id,
      sourceType: 'text',
      recallPrompt: value.recallPrompt,
      referenceAnswer: value.coreLesson,
      tags: ['reason', 'example'],
      fsrsCard: { due: now },
    });
    expect(saved).toMatchObject({ manualReward: 3, allowance: null });
    expect(
      (await new WalletRepository(repository).load()).ledger.filter(
        (entry) => entry.source === 'capture',
      ),
    ).toHaveLength(0);
    const repeated = await saveManualQuestion(value, 'standard', deps);
    expect(repeated).toEqual(saved);
    expect((await new WalletRepository(repository).load()).balance).toBe(3);
    expect(await repository.listItems()).toHaveLength(1);
  });
  it('preserves reading evidence and its +2 capture / daily check-in path', async () => {
    const value = {
      ...draft(),
      source: 'reading' as const,
      excerpt: 'Exact original\n第二段',
      bookTitle: 'Book',
      location: '42',
    };
    const saved = await saveManualQuestion(value, 'standard', deps);
    expect(saved.item).toMatchObject({
      title: value.recallPrompt.trim(),
      readingSource: { excerpt: value.excerpt, bookTitle: 'Book', location: '42' },
      tags: ['reason', 'example'],
    });
    expect(saved.allowance).toMatchObject({ captureReward: 2, checkInReward: 5 });
    expect(
      (await new WalletRepository(repository).load()).ledger.filter(
        (entry) => entry.source === 'manual',
      ),
    ).toHaveLength(0);
    await saveManualQuestion(value, 'standard', deps);
    expect((await new WalletRepository(repository).load()).balance).toBe(7);
  });
  it.each([
    ['https://www.youtube.com/watch?v=abcdefghijk', 'youtube', 83],
    ['https://www.bilibili.com/video/BV1Ab411c7Cd', 'bilibili', null],
    ['https://www.douyin.com/video/7391234567890123456', 'douyin', null],
  ])('creates a manual link without capture for %s', async (url, platform, seconds) => {
    const saved = await saveManualQuestion(
      {
        ...draft(),
        source: 'video',
        videoUrl: String(url),
        timestamp: seconds === 83 ? '01:23' : '',
      },
      'standard',
      deps,
    );
    expect(saved.item).toMatchObject({
      sourceType: 'video',
      videoOrigin: 'library',
      platform,
      screenshotId: null,
      timestampSeconds: seconds,
      extractionDiagnostics: [],
    });
    expect(
      (await new WalletRepository(repository).load()).ledger.filter(
        (entry) => entry.source === 'capture',
      ),
    ).toHaveLength(0);
  });
  it('rejects missing fields and unsupported URLs/times without writing or rewards', async () => {
    for (const value of [
      newManualDraft(),
      { ...draft(), source: 'video' as const, videoUrl: 'https://example.com' },
      {
        ...draft(),
        source: 'video' as const,
        videoUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
        timestamp: 'bad',
      },
      { ...draft(), source: 'image' as const },
    ]) {
      await expect(saveManualQuestion(value, 'standard', deps)).rejects.toThrow();
    }
    expect(await repository.listItems()).toEqual([]);
    expect(
      (await new WalletRepository(repository).load()).ledger.filter(
        (entry) => entry.source === 'manual',
      ),
    ).toHaveLength(0);
  });
  it('recovers a lost write response under the same UUID and never grants a second reward', async () => {
    const value = draft();
    const create = repository.createTextItem.bind(repository);
    vi.spyOn(repository, 'createTextItem').mockImplementationOnce(async (input, commit) => {
      await create(input, commit);
      throw new Error('response lost');
    });
    await expect(saveManualQuestion(value, 'standard', deps)).rejects.toThrow('response lost');
    expect((await saveManualQuestion(value, 'standard', deps)).manualReward).toBe(3);
    expect(await repository.listItems()).toHaveLength(1);
    expect(
      (await new WalletRepository(repository).load()).ledger.filter(
        (entry) => entry.source === 'manual',
      ),
    ).toHaveLength(1);
  });
  it('keeps a mismatched existing payload unchanged and retains an actionable conflict', async () => {
    const value = draft();
    await saveManualQuestion(value, 'standard', deps);
    await expect(
      saveManualQuestion(
        { ...value, coreLesson: 'Changed after a lost response' },
        'standard',
        deps,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await repository.getItem(value.id))?.coreLesson).toBe(value.coreLesson);
    expect((await new WalletRepository(repository).load()).balance).toBe(3);
  });
  it('recovers a lost response when a deleted category was resolved to uncategorized', async () => {
    const category = await repository.createCategory('Reading');
    const value = { ...draft(), categoryId: category.id };
    await repository.deleteCategory(category.id);
    const create = repository.createTextItem.bind(repository);
    vi.spyOn(repository, 'createTextItem').mockImplementationOnce(async (input, commit) => {
      await create(input, commit);
      throw new Error('response lost');
    });
    await expect(saveManualQuestion(value, 'standard', deps)).rejects.toThrow('response lost');
    const recovered = await saveManualQuestion(value, 'standard', deps);
    expect(recovered.item.categoryId).toBeNull();
    expect(recovered.manualReward).toBe(3);
    expect(await repository.listItems()).toHaveLength(1);
    expect(
      (await new WalletRepository(repository).load()).ledger.filter(
        (entry) => entry.source === 'manual',
      ),
    ).toHaveLength(1);
    expect(
      (await new WalletRepository(repository).load()).ledger.filter(
        (entry) => entry.source === 'capture',
      ),
    ).toHaveLength(0);
  });
  it('does not treat a still-existing different category as a lost-response match', async () => {
    const value = draft();
    await saveManualQuestion(value, 'standard', deps);
    const category = await repository.createCategory('Reading');
    await expect(
      saveManualQuestion({ ...value, categoryId: category.id }, 'standard', deps),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await repository.getItem(value.id))?.categoryId).toBeNull();
    expect(await repository.listItems()).toHaveLength(1);
    expect((await new WalletRepository(repository).load()).balance).toBe(3);
  });
  it('compares image bytes during recovery and never creates another asset', async () => {
    const value = {
      ...draft(),
      source: 'image' as const,
      image: { blob: new Blob(['abc'], { type: 'image/png' }), width: 100, height: 50 },
    };
    const saved = await saveManualQuestion(value, 'standard', deps);
    expect(saved.item).toMatchObject({ sourceType: 'image', imageAssetId: `image-${value.id}` });
    expect(await saveManualQuestion(value, 'standard', deps)).toEqual(saved);
    await expect(
      saveManualQuestion(
        { ...value, image: { ...value.image, blob: new Blob(['def'], { type: 'image/png' }) } },
        'standard',
        deps,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await new WalletRepository(repository).load()).balance).toBe(3);
    expect((await repository.exportData()).screenshots).toHaveLength(1);
  });
  it('rolls back formal saving when the wallet cannot be read', async () => {
    const value = draft();
    const tx = (await repository.open()).transaction(STORE_NAMES.wallet, 'readwrite');
    const done = transactionComplete(tx);
    tx.objectStore(STORE_NAMES.wallet).put({ key: 'state', value: { balance: 'broken' } });
    await done;
    await expect(saveManualQuestion(value, 'standard', deps)).rejects.toThrow();
    expect(await repository.listItems()).toHaveLength(0);
  });
});
