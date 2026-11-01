// @vitest-environment node

import { IDBFactory } from 'fake-indexeddb';
import { Rating, createEmptyCard, fsrs } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';

import { itemToPersisted, reviewRecordToPersisted } from './mappers';
import { DATABASE_VERSION, INDEX_NAMES, STORE_NAMES, runMigrations } from './migrations';
import { ValRecallRepository } from './repository';
import type { ReviewRecord, VideoLearningItem } from './types';

describe('IndexedDB task migration', () => {
  it('upgrades a production-v1 database additively and preserves learning data and FSRS', async () => {
    const factory = new IDBFactory();
    const databaseName = 'migration-v1-to-v2';
    const initialDate = new Date('2026-07-20T12:00:00.000Z');
    const item = learningItem(initialDate);
    const result = fsrs().next(item.fsrsCard, initialDate, Rating.Good);
    const review: ReviewRecord = {
      id: 'review-before-upgrade',
      itemId: item.id,
      reviewedAt: initialDate,
      log: result.log,
    };
    const persistedItem = itemToPersisted(item);
    const persistedReview = reviewRecordToPersisted(review);

    const versionOne = await openVersionOne(factory, databaseName);
    const seedTransaction = versionOne.transaction(
      [STORE_NAMES.items, STORE_NAMES.screenshots, STORE_NAMES.reviews, STORE_NAMES.meta],
      'readwrite',
    );
    seedTransaction.objectStore(STORE_NAMES.items).put(persistedItem);
    seedTransaction.objectStore(STORE_NAMES.screenshots).put({
      id: 'screenshot-before-upgrade',
      blob: new Blob(['protected-image'], { type: 'image/png' }),
      createdAt: initialDate.toISOString(),
    });
    seedTransaction.objectStore(STORE_NAMES.reviews).put(persistedReview);
    seedTransaction.objectStore(STORE_NAMES.meta).put({
      key: 'protected-meta',
      value: { keep: true },
      updatedAt: initialDate.toISOString(),
    });
    seedTransaction.objectStore(STORE_NAMES.meta).put({
      key: 'runtime.pendingCapture',
      value: { draftId: 'pending-before-upgrade' },
      updatedAt: initialDate.toISOString(),
    });
    await transactionDone(seedTransaction);
    versionOne.close();

    const repository = new ValRecallRepository({
      indexedDBFactory: factory,
      databaseName,
      clock: () => new Date(initialDate),
    });
    const upgraded = await repository.open();

    expect(upgraded.version).toBe(DATABASE_VERSION);
    expect([...upgraded.objectStoreNames]).toEqual(
      expect.arrayContaining(Object.values(STORE_NAMES)),
    );
    const taskIndexTransaction = upgraded.transaction(
      [STORE_NAMES.dailyTasks, STORE_NAMES.taskCompletions],
      'readonly',
    );
    expect(
      taskIndexTransaction
        .objectStore(STORE_NAMES.dailyTasks)
        .indexNames.contains(INDEX_NAMES.taskLinkedLearningItem),
    ).toBe(true);
    expect(
      taskIndexTransaction
        .objectStore(STORE_NAMES.taskCompletions)
        .index(INDEX_NAMES.completionTaskAndDate).unique,
    ).toBe(true);
    await transactionDone(taskIndexTransaction);

    const loaded = await repository.getItem(item.id);
    expect(loaded?.fsrsCard).toEqual(item.fsrsCard);
    expect(loaded?.reviewHistory).toHaveLength(1);
    expect(loaded?.reviewHistory[0]?.log).toEqual(result.log);
    await expect(repository.getScreenshot('screenshot-before-upgrade')).resolves.toMatchObject({
      size: 15,
      type: 'image/png',
    });
    await expect(repository.getMeta('protected-meta')).resolves.toEqual({ keep: true });
    await expect(repository.getMeta('runtime.pendingCapture')).resolves.toEqual({
      draftId: 'pending-before-upgrade',
    });
    await expect(repository.getMeta('databaseSchemaVersion')).resolves.toBe(6);

    const rawTransaction = upgraded.transaction(
      [STORE_NAMES.items, STORE_NAMES.reviews],
      'readonly',
    );
    const rawItemRequest = rawTransaction.objectStore(STORE_NAMES.items).get(item.id);
    const rawReviewRequest = rawTransaction.objectStore(STORE_NAMES.reviews).get(review.id);
    const [rawItem, rawReview] = await Promise.all([
      requestResult(rawItemRequest),
      requestResult(rawReviewRequest),
    ]);
    await transactionDone(rawTransaction);
    expect(rawItem).toEqual(persistedItem);
    expect(rawReview).toEqual(persistedReview);
  });
});

function openVersionOne(factory: IDBFactory, databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(databaseName, 1);
    request.addEventListener('upgradeneeded', (event) => {
      const transaction = request.transaction;
      if (!transaction) throw new Error('Expected a version-one upgrade transaction.');
      runMigrations(request.result, transaction, event.oldVersion, 1);
    });
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error), { once: true });
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error), { once: true });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error), { once: true });
    transaction.addEventListener('error', () => reject(transaction.error), { once: true });
  });
}

function learningItem(now: Date): VideoLearningItem {
  return {
    id: 'item-before-upgrade',
    schemaVersion: 2,
    platform: 'bilibili',
    sourceUrl: 'https://www.bilibili.com/video/BV1migration',
    canonicalUrl: null,
    videoId: 'BV1migration',
    videoTitle: 'Protected learning item',
    uploader: null,
    description: null,
    timestampSeconds: 30,
    timestampDisplay: '00:30',
    videoDurationSeconds: 90,
    chapterTitle: null,
    screenshotId: 'screenshot-before-upgrade',
    subtitleBefore: [],
    subtitleCurrent: [],
    subtitleAfter: [],
    subtitleCueData: [],
    categoryId: null,
    itemType: 'Notice',
    personalNote: '',
    situation: '',
    coreLesson: 'Keep the existing card.',
    mistakeToAvoid: '',
    recommendedAction: '',
    reason: '',
    recallPrompt: 'What must stay unchanged?',
    referenceAnswer: 'The learning item and FSRS card.',
    tags: [],
    createdAt: new Date(now),
    updatedAt: new Date(now),
    fsrsCard: createEmptyCard(now),
    reviewHistory: [],
    suspended: false,
    extractionDiagnostics: [],
  };
}
