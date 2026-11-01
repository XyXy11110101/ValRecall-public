import { Rating, createEmptyCard, fsrs } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';

import type { ReviewRecord, VideoLearningItem } from '../database';
import { buildDashboardHomeSummary } from './home-summary';

const now = new Date(2026, 6, 21, 12, 0, 0);

function review(id: string, itemId: string, reviewedAt: Date): ReviewRecord {
  const result = fsrs().next(createEmptyCard(reviewedAt), reviewedAt, Rating.Good);
  return { id, itemId, reviewedAt, log: result.log };
}

function item(
  id: string,
  {
    createdAt = new Date(2026, 6, 20, 12, 0, 0),
    due = now,
    reviews = [],
    suspended = false,
  }: {
    createdAt?: Date;
    due?: Date;
    reviews?: ReviewRecord[];
    suspended?: boolean;
  } = {},
): VideoLearningItem {
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
    timestampSeconds: 30,
    timestampDisplay: '00:30',
    videoDurationSeconds: 180,
    chapterTitle: null,
    screenshotId: null,
    subtitleBefore: [],
    subtitleCurrent: [],
    subtitleAfter: [],
    subtitleCueData: [],
    categoryId: null,
    itemType: 'Understand',
    personalNote: '',
    situation: '',
    coreLesson: `Core lesson ${id}`,
    mistakeToAvoid: '',
    recommendedAction: '',
    reason: '',
    recallPrompt: `Recall ${id}`,
    referenceAnswer: `Answer ${id}`,
    tags: [],
    createdAt,
    updatedAt: createdAt,
    fsrsCard: { ...createEmptyCard(due), due },
    reviewHistory: reviews,
    suspended,
    extractionDiagnostics: [],
  };
}

describe('buildDashboardHomeSummary', () => {
  it('counts only unsuspended items due at or before the supplied clock', () => {
    const summary = buildDashboardHomeSummary(
      [
        item('overdue', { due: new Date(2026, 6, 20) }),
        item('due-now'),
        item('future', { due: new Date(2026, 6, 22) }),
        item('suspended-due', { due: new Date(2026, 6, 20), suspended: true }),
      ],
      now,
    );

    expect(summary.dueCount).toBe(2);
  });

  it('counts every review completed during the current local calendar day', () => {
    const summary = buildDashboardHomeSummary(
      [
        item('reviewed', {
          reviews: [
            review('midnight', 'reviewed', new Date(2026, 6, 21, 0, 0, 0)),
            review('later', 'reviewed', new Date(2026, 6, 21, 18, 30, 0)),
            review('yesterday', 'reviewed', new Date(2026, 6, 20, 23, 59, 59)),
            review('tomorrow', 'reviewed', new Date(2026, 6, 22, 0, 0, 0)),
          ],
        }),
      ],
      now,
    );

    expect(summary.reviewsCompletedToday).toBe(2);
  });

  it('selects newest captures and nearest future unsuspended reviews', () => {
    const items = [
      item('middle-capture', {
        createdAt: new Date(2026, 6, 19),
        due: new Date(2026, 6, 24),
      }),
      item('old-capture-near-due', {
        createdAt: new Date(2026, 6, 18),
        due: new Date(2026, 6, 22),
      }),
      item('new-capture-far-due', {
        createdAt: new Date(2026, 6, 21),
        due: new Date(2026, 6, 25),
      }),
      item('suspended-future', {
        createdAt: new Date(2026, 6, 20),
        due: new Date(2026, 6, 21, 13),
        suspended: true,
      }),
    ];

    const summary = buildDashboardHomeSummary(items, now, {
      recentLimit: 3,
      upcomingLimit: 2,
    });

    expect(summary.recentCaptures.map(({ id }) => id)).toEqual([
      'new-capture-far-due',
      'suspended-future',
      'middle-capture',
    ]);
    expect(summary.upcomingReviews.map(({ id }) => id)).toEqual([
      'old-capture-near-due',
      'middle-capture',
    ]);
  });

  it('does not mutate item order, FSRS cards, or review histories', () => {
    const firstReview = review('review-1', 'first', new Date(2026, 6, 21, 9));
    const items = [
      item('first', {
        createdAt: new Date(2026, 6, 18),
        due: new Date(2026, 6, 25),
        reviews: [firstReview],
      }),
      item('second', {
        createdAt: new Date(2026, 6, 21),
        due: new Date(2026, 6, 22),
      }),
    ];
    const originalOrder = items.map(({ id }) => id);
    const originalDue = items.map(({ fsrsCard }) => fsrsCard.due.toISOString());
    const originalReviews = [...items[0]!.reviewHistory];

    buildDashboardHomeSummary(items, now);

    expect(items.map(({ id }) => id)).toEqual(originalOrder);
    expect(items.map(({ fsrsCard }) => fsrsCard.due.toISOString())).toEqual(originalDue);
    expect(items[0]?.reviewHistory).toEqual(originalReviews);
  });
});
