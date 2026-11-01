import { Rating, createEmptyCard, fsrs, type Grade } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';

import type { ImageLearningItem, VideoLearningItem } from '../database';
import type { PersistedFsrsReviewResult } from '../fsrs';
import {
  createReviewSessionSnapshot,
  createReviewSessionSummary,
  recordMasteredMoment,
  recordSuccessfulReview,
  recordUnavailableMoment,
  reviewedTotal,
  reviewSessionProgress,
} from './review-session';

const now = new Date('2026-08-03T08:00:00.000Z');

describe('review session model', () => {
  it('reorders only the new snapshot and keeps the first occurrence of a repeated ID', () => {
    const first = item('first');
    const preferred = item('preferred');
    const duplicate = { ...preferred, coreLesson: 'Must not replace the first occurrence' };
    const source = Object.freeze([first, preferred, duplicate]);
    const snapshot = createReviewSessionSnapshot(source, preferred.id);
    expect(snapshot.map((entry) => entry.id)).toEqual(['preferred', 'first']);
    expect(snapshot[0]?.coreLesson).toBe(preferred.coreLesson);
    expect(snapshot[0]).not.toBe(preferred);
    expect(source).toEqual([first, preferred, duplicate]);
    expect(createReviewSessionSnapshot(source, 'missing').map((entry) => entry.id)).toEqual([
      'first',
      'preferred',
    ]);
  });

  it('takes a stable de-duplicated snapshot and prioritizes one due Moment', () => {
    const first = item('first');
    const preferred = item('preferred');

    expect(
      createReviewSessionSnapshot([first, preferred, first, item('third')], preferred.id).map(
        ({ id }) => id,
      ),
    ).toEqual(['preferred', 'first', 'third']);
  });

  it('clones the scheduling state so source or preview mutation cannot alter the snapshot', () => {
    const source = item('isolated');
    const snapshot = createReviewSessionSnapshot([source], null)[0]!;
    const expectedDue = snapshot.fsrsCard.due.getTime();

    source.fsrsCard.due.setTime(source.fsrsCard.due.getTime() + 1);
    source.fsrsCard.reps += 1;
    source.tags.push('mutated');

    expect(snapshot.fsrsCard.due.getTime()).toBe(expectedDue);
    expect(snapshot.fsrsCard.reps).toBe(0);
    expect(snapshot.tags).toEqual([]);
  });

  it('clones Image and Library-created Video Moments without inventing capture data', () => {
    const image = imageItem('image');
    const manualVideo: VideoLearningItem = {
      ...item('manual-video'),
      sourceType: 'video',
      videoOrigin: 'library',
      timestampSeconds: null,
      timestampDisplay: null,
      screenshotId: null,
    };

    const [imageSnapshot, videoSnapshot] = createReviewSessionSnapshot([image, manualVideo], null);
    image.tags.push('changed-after-snapshot');
    manualVideo.subtitleCurrent.push('changed-after-snapshot');

    expect(imageSnapshot).toMatchObject({
      sourceType: 'image',
      imageAssetId: 'asset-image',
      imageMimeType: 'image/webp',
      imageWidth: 1200,
      imageHeight: 800,
      tags: [],
    });
    expect(videoSnapshot).toMatchObject({
      sourceType: 'video',
      videoOrigin: 'library',
      timestampSeconds: null,
      timestampDisplay: null,
      screenshotId: null,
      subtitleCurrent: [],
    });
  });

  it('reports current position from the fixed initial total', () => {
    const summary = createReviewSessionSummary(12);

    expect(reviewSessionProgress(summary, 12)).toEqual({
      current: 1,
      total: 12,
      processed: 0,
      remaining: 12,
    });
    expect(reviewSessionProgress(summary, 9)).toEqual({
      current: 4,
      total: 12,
      processed: 3,
      remaining: 9,
    });
  });

  it('aggregates factual ratings and the earliest returned due time', () => {
    let summary = createReviewSessionSummary(4);
    summary = recordSuccessfulReview(
      summary,
      'hard',
      result('hard', Rating.Hard, new Date('2026-08-04T12:00:00.000Z')),
    );
    summary = recordSuccessfulReview(
      summary,
      'again',
      result('again', Rating.Again, new Date('2026-08-03T08:01:00.000Z')),
    );
    summary = recordSuccessfulReview(
      summary,
      'good',
      result('good', Rating.Good, new Date('2026-08-06T12:00:00.000Z')),
    );
    summary = recordSuccessfulReview(
      summary,
      'easy',
      result('easy', Rating.Easy, new Date('2026-08-12T12:00:00.000Z')),
    );

    expect(summary.ratingCounts).toEqual({ again: 1, hard: 1, good: 1, easy: 1 });
    expect(summary.earliestNextDue?.toISOString()).toBe('2026-08-03T08:01:00.000Z');
    expect(reviewedTotal(summary)).toBe(4);
  });

  it('records mastered Moments separately from ratings and unavailable skips', () => {
    const initial = createReviewSessionSummary(2);
    const mastered = recordMasteredMoment(initial, 'done');
    expect(mastered.masteredItemIds).toEqual(['done']);
    expect(reviewedTotal(mastered)).toBe(0);
    expect(recordMasteredMoment(mastered, 'done').masteredItemIds).toEqual(['done']);
    expect(recordUnavailableMoment(mastered, 'done').unavailableItemIds).toEqual([]);
  });

  it('does not count the same Moment twice in one session', () => {
    const initial = createReviewSessionSummary(1);
    const once = recordSuccessfulReview(
      initial,
      'same',
      result('same', Rating.Good, new Date('2026-08-04T08:00:00.000Z')),
    );

    expect(
      recordSuccessfulReview(
        once,
        'same',
        result('same', Rating.Again, new Date('2026-08-03T08:01:00.000Z')),
      ),
    ).toBe(once);
  });

  it('tracks unavailable snapshot Moments separately from successful reviews', () => {
    const initial = createReviewSessionSummary(2);
    const unavailable = recordUnavailableMoment(initial, 'removed');

    expect(unavailable.unavailableItemIds).toEqual(['removed']);
    expect(reviewedTotal(unavailable)).toBe(0);
    expect(recordUnavailableMoment(unavailable, 'removed')).toBe(unavailable);
  });
});

function result(itemId: string, rating: Grade, nextDue: Date): PersistedFsrsReviewResult {
  const scheduled = fsrs().next(createEmptyCard(now), now, rating);
  return {
    rating,
    card: { ...scheduled.card, due: nextDue },
    log: scheduled.log,
    nextDue,
    itemId,
    reviewRecord: {
      id: `review-${itemId}`,
      itemId,
      reviewedAt: now,
      log: scheduled.log,
    },
  };
}

function item(id: string): VideoLearningItem {
  return {
    id,
    schemaVersion: 2,
    platform: 'bilibili',
    sourceUrl: `https://www.bilibili.com/video/${id}`,
    canonicalUrl: null,
    videoId: id,
    videoTitle: `Lesson ${id}`,
    uploader: null,
    description: null,
    timestampSeconds: 42,
    timestampDisplay: '00:42',
    videoDurationSeconds: 180,
    chapterTitle: null,
    screenshotId: null,
    subtitleBefore: [],
    subtitleCurrent: [],
    subtitleAfter: [],
    subtitleCueData: [],
    categoryId: null,
    itemType: 'Do',
    personalNote: '',
    situation: '',
    coreLesson: '',
    mistakeToAvoid: '',
    recommendedAction: '',
    reason: '',
    recallPrompt: `Recall ${id}`,
    referenceAnswer: `Answer ${id}`,
    tags: [],
    createdAt: now,
    updatedAt: now,
    fsrsCard: createEmptyCard(now),
    reviewHistory: [],
    suspended: false,
    extractionDiagnostics: [],
  };
}

function imageItem(id: string): ImageLearningItem {
  return {
    id,
    schemaVersion: 2,
    sourceType: 'image',
    title: `Image ${id}`,
    imageAssetId: `asset-${id}`,
    imageMimeType: 'image/webp',
    imageWidth: 1200,
    imageHeight: 800,
    categoryId: null,
    itemType: 'Notice',
    personalNote: '',
    situation: '',
    coreLesson: `Core ${id}`,
    mistakeToAvoid: '',
    recommendedAction: '',
    reason: '',
    recallPrompt: `Recall ${id}`,
    referenceAnswer: `Answer ${id}`,
    tags: [],
    createdAt: now,
    updatedAt: now,
    fsrsCard: createEmptyCard(now),
    reviewHistory: [],
    suspended: false,
    extractionDiagnostics: [],
  };
}
