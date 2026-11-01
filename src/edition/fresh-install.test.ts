// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ValRecallRepository } from '../database';
import { requestResult, transactionComplete } from '../database/idb';
import { STORE_NAMES } from '../database/migrations';
import { FsrsService } from '../fsrs';
import { freshCompanionMessage, isFreshInstall, type SavedOnceStore } from './fresh-install';

function memoryStore(saved = false): SavedOnceStore & { saved(): boolean } {
  return {
    load: async () => saved,
    save: async () => {
      saved = true;
    },
    saved: () => saved,
  };
}

const now = new Date('2026-11-01T12:00:00Z');

describe('isFreshInstall', () => {
  let repository: ValRecallRepository;
  const question = {
    title: 'A question',
    itemType: 'Understand' as const,
    recallPrompt: 'Why?',
    coreLesson: 'Because.',
    referenceAnswer: 'Because.',
    tags: [],
    fsrsCard: new FsrsService({ clock: () => now }).createInitialCard(),
  };

  beforeEach(() => {
    repository = new ValRecallRepository({
      databaseName: 'fresh-install',
      indexedDBFactory: new IDBFactory(),
      clock: () => now,
    });
  });

  it('is fresh with no items and nothing remembered', async () => {
    const store = memoryStore();
    await expect(isFreshInstall(repository, store)).resolves.toBe(true);
    expect(store.saved()).toBe(false);
  });

  it('remembers the first item it sees', async () => {
    const store = memoryStore();
    await repository.createTextItem({ ...question, id: 'kept' });
    await expect(isFreshInstall(repository, store)).resolves.toBe(false);
    expect(store.saved()).toBe(true);
  });

  it('is not fresh after every item was deleted, and does not need to read them', async () => {
    const listRecentItems = vi.spyOn(repository, 'listRecentItems');
    await expect(isFreshInstall(repository, memoryStore(true))).resolves.toBe(false);
    expect(listRecentItems).not.toHaveBeenCalled();
  });

  it.each(['manual', 'capture'] as const)(
    'is not fresh when a %s save was deleted before anything saw it',
    async (kind) => {
      const store = memoryStore();
      await repository.createTextItem(
        { ...question, id: 'gone' },
        { id: 'save-1', kind, fingerprint: 'same' },
      );
      await repository.deleteItem('gone');
      await expect(repository.listRecentItems(1)).resolves.toEqual([]);
      await expect(isFreshInstall(repository, store)).resolves.toBe(false);
      expect(store.saved()).toBe(true);
    },
  );

  it('is not fresh after delete-all, even with nothing remembered', async () => {
    await repository.createTextItem(
      { ...question, id: 'gone' },
      { id: 'save-1', kind: 'manual', fingerprint: 'same' },
    );
    await repository.clearAllData();
    await expect(isFreshInstall(repository, memoryStore())).resolves.toBe(false);
  });

  async function addIntakeReceipt(questions: number) {
    const transaction = (await repository.open()).transaction(
      STORE_NAMES.learningReceipts,
      'readwrite',
    );
    const done = transactionComplete(transaction);
    await requestResult(
      transaction.objectStore(STORE_NAMES.learningReceipts).add({
        schemaVersion: 1,
        kind: 'intake',
        id: 'package-1',
        fingerprint: 'same',
        committedAt: now.toISOString(),
        result: { questions, notes: 0, entries: [], rewardReceiptIds: [] },
        rewardAmount: 0,
      }),
    );
    await done;
  }

  it('counts a received package that added a question', async () => {
    await addIntakeReceipt(1);
    await expect(isFreshInstall(repository, memoryStore())).resolves.toBe(false);
  });

  it('does not count a received package that added none', async () => {
    await addIntakeReceipt(0);
    await expect(isFreshInstall(repository, memoryStore())).resolves.toBe(true);
  });

  it('keeps the ordinary wording when a receipt cannot be read', async () => {
    const transaction = (await repository.open()).transaction(
      STORE_NAMES.learningReceipts,
      'readwrite',
    );
    const done = transactionComplete(transaction);
    transaction.objectStore(STORE_NAMES.learningReceipts).add({ id: 'broken' });
    await done;
    await expect(isFreshInstall(repository, memoryStore())).rejects.toThrow();
  });
});

describe('freshCompanionMessage', () => {
  it('never says a new user is caught up or has finished reviews', () => {
    expect(freshCompanionMessage(0)).toBe('还没有内容。先存一条吧。');
    expect(freshCompanionMessage(2)).toBe('还有 2 项任务。');
  });
});
