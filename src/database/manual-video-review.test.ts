// @vitest-environment node

import { IDBFactory } from 'fake-indexeddb';
import { Rating, createEmptyCard } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';

import { FsrsService } from '../fsrs';
import { ValRecallRepository } from './repository';

const reviewedAt = new Date('2026-08-09T12:00:00.000Z');

describe('Library-created Video review persistence', () => {
  it('reviews and round-trips a timestamp-free Video without inventing capture data', async () => {
    let sequence = 0;
    const repository = new ValRecallRepository({
      indexedDBFactory: new IDBFactory(),
      databaseName: 'manual-video-review',
      clock: () => new Date(reviewedAt),
      idGenerator: () => `manual-review-${(sequence += 1)}`,
    });
    const importedRepository = new ValRecallRepository({
      indexedDBFactory: new IDBFactory(),
      databaseName: 'manual-video-review-import',
      clock: () => new Date(reviewedAt),
    });

    try {
      const created = await repository.createManualVideoItem({
        id: 'manual-youtube-without-timestamp',
        platform: 'youtube',
        sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
        canonicalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
        videoId: 'abcdefghijk',
        videoTitle: 'Timestamp-free manual video',
        timestampSeconds: null,
        timestampDisplay: null,
        itemType: 'Understand',
        coreLesson: 'Use the same scheduling path as every other Moment.',
        recallPrompt: 'How should this manual Video Moment be scheduled?',
        referenceAnswer: 'With the shared FSRS card and review history.',
        fsrsCard: createEmptyCard(reviewedAt),
      });
      const initialDue = created.fsrsCard.due.toISOString();

      const service = new FsrsService(repository, { clock: () => new Date(reviewedAt) });
      const result = await service.reviewItem(created.id, Rating.Good, reviewedAt);
      const reviewed = await repository.getItem(created.id);

      expect(result.nextDue.getTime()).toBeGreaterThan(reviewedAt.getTime());
      expect(result.nextDue.toISOString()).not.toBe(initialDue);
      expect(reviewed).toMatchObject({
        id: created.id,
        sourceType: 'video',
        videoOrigin: 'library',
        timestampSeconds: null,
        timestampDisplay: null,
        screenshotId: null,
        uploader: null,
        description: null,
        chapterTitle: null,
        videoDurationSeconds: null,
        subtitleBefore: [],
        subtitleCurrent: [],
        subtitleAfter: [],
        subtitleCueData: [],
        extractionDiagnostics: [],
      });
      expect(reviewed?.fsrsCard.due.toISOString()).toBe(result.nextDue.toISOString());
      expect(reviewed?.reviewHistory).toHaveLength(1);
      await expect(repository.listReviews(created.id)).resolves.toHaveLength(1);

      const exported = await repository.exportData();
      expect(exported.screenshots).toEqual([]);
      expect(exported.reviews).toHaveLength(1);

      await importedRepository.importData(exported, 'replace');
      const restored = await importedRepository.getItem(created.id);
      expect(restored).toMatchObject({
        sourceType: 'video',
        videoOrigin: 'library',
        timestampSeconds: null,
        timestampDisplay: null,
        screenshotId: null,
        subtitleBefore: [],
        subtitleCurrent: [],
        subtitleAfter: [],
        subtitleCueData: [],
        extractionDiagnostics: [],
      });
      expect(restored?.fsrsCard.due.toISOString()).toBe(result.nextDue.toISOString());
      expect(restored?.reviewHistory).toHaveLength(1);
      await expect(importedRepository.listReviews(created.id)).resolves.toHaveLength(1);
      await expect(importedRepository.exportData()).resolves.toMatchObject({
        screenshots: [],
        reviews: [expect.objectContaining({ itemId: created.id })],
      });
    } finally {
      repository.close();
      importedRepository.close();
    }
  });
});
