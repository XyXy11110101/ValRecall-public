import { Rating } from 'ts-fsrs';

import type { LearningItem } from '../database';
import type { PersistedFsrsReviewResult } from '../fsrs';

export interface ReviewSessionRatingCounts {
  again: number;
  hard: number;
  good: number;
  easy: number;
}

export interface ReviewSessionSummary {
  initialTotal: number;
  reviewedItemIds: string[];
  unavailableItemIds: string[];
  masteredItemIds: string[];
  ratingCounts: ReviewSessionRatingCounts;
  earliestNextDue: Date | null;
}

export interface ReviewSessionProgress {
  current: number;
  total: number;
  processed: number;
  remaining: number;
}

export function createReviewSessionSnapshot(
  dueItems: readonly LearningItem[],
  preferredItemId: string | null,
): LearningItem[] {
  const seen = new Set<string>();
  const stable: LearningItem[] = [];
  for (const item of dueItems) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    stable.push(cloneReviewSessionItem(item));
  }
  if (preferredItemId === null) return stable;
  const preferredIndex = stable.findIndex((item) => item.id === preferredItemId);
  if (preferredIndex > 0) {
    const [preferred] = stable.splice(preferredIndex, 1);
    stable.unshift(preferred!);
  }
  return stable;
}

export function cloneReviewSessionItem(item: LearningItem): LearningItem {
  const cloneCommon = {
    tags: [...item.tags],
    createdAt: new Date(item.createdAt.getTime()),
    updatedAt: new Date(item.updatedAt.getTime()),
    fsrsCard: {
      ...item.fsrsCard,
      due: new Date(item.fsrsCard.due.getTime()),
      ...(item.fsrsCard.last_review
        ? { last_review: new Date(item.fsrsCard.last_review.getTime()) }
        : {}),
    },
    reviewHistory: item.reviewHistory.map((review) => ({
      ...review,
      reviewedAt: new Date(review.reviewedAt.getTime()),
      log: {
        ...review.log,
        due: new Date(review.log.due.getTime()),
        review: new Date(review.log.review.getTime()),
      },
    })),
    extractionDiagnostics: item.extractionDiagnostics.map((diagnostic) => ({ ...diagnostic })),
  };
  if (item.sourceType === 'text') {
    return {
      ...item,
      ...cloneCommon,
      ...(item.readingSource ? { readingSource: { ...item.readingSource } } : {}),
      ...(item.noteSource ? { noteSource: { ...item.noteSource } } : {}),
    };
  }
  if (item.sourceType === 'image') {
    return { ...item, ...cloneCommon };
  }
  return {
    ...item,
    ...cloneCommon,
    subtitleBefore: [...item.subtitleBefore],
    subtitleCurrent: [...item.subtitleCurrent],
    subtitleAfter: [...item.subtitleAfter],
    subtitleCueData: item.subtitleCueData.map((cue) => ({ ...cue })),
  };
}

export function createReviewSessionSummary(initialTotal: number): ReviewSessionSummary {
  return {
    initialTotal,
    reviewedItemIds: [],
    unavailableItemIds: [],
    masteredItemIds: [],
    ratingCounts: { again: 0, hard: 0, good: 0, easy: 0 },
    earliestNextDue: null,
  };
}

export function recordSuccessfulReview(
  summary: ReviewSessionSummary,
  itemId: string,
  result: PersistedFsrsReviewResult,
): ReviewSessionSummary {
  if (
    summary.reviewedItemIds.includes(itemId) ||
    summary.unavailableItemIds.includes(itemId) ||
    summary.masteredItemIds.includes(itemId)
  ) {
    return summary;
  }

  const nextCounts = { ...summary.ratingCounts };
  switch (result.rating) {
    case Rating.Again:
      nextCounts.again += 1;
      break;
    case Rating.Hard:
      nextCounts.hard += 1;
      break;
    case Rating.Good:
      nextCounts.good += 1;
      break;
    case Rating.Easy:
      nextCounts.easy += 1;
      break;
  }

  const nextDue = new Date(result.nextDue.getTime());
  return {
    ...summary,
    reviewedItemIds: [...summary.reviewedItemIds, itemId],
    ratingCounts: nextCounts,
    earliestNextDue:
      summary.earliestNextDue === null || nextDue < summary.earliestNextDue
        ? nextDue
        : new Date(summary.earliestNextDue.getTime()),
  };
}

export function recordUnavailableMoment(
  summary: ReviewSessionSummary,
  itemId: string,
): ReviewSessionSummary {
  if (
    summary.reviewedItemIds.includes(itemId) ||
    summary.unavailableItemIds.includes(itemId) ||
    summary.masteredItemIds.includes(itemId)
  ) {
    return summary;
  }
  return {
    ...summary,
    unavailableItemIds: [...summary.unavailableItemIds, itemId],
  };
}

export function recordMasteredMoment(
  summary: ReviewSessionSummary,
  itemId: string,
): ReviewSessionSummary {
  if (
    summary.reviewedItemIds.includes(itemId) ||
    summary.unavailableItemIds.includes(itemId) ||
    summary.masteredItemIds.includes(itemId)
  ) {
    return summary;
  }
  return {
    ...summary,
    masteredItemIds: [...summary.masteredItemIds, itemId],
  };
}

export function reviewSessionProgress(
  summary: ReviewSessionSummary,
  remaining: number,
): ReviewSessionProgress {
  const boundedRemaining = Math.max(0, Math.min(summary.initialTotal, remaining));
  const processed = summary.initialTotal - boundedRemaining;
  return {
    current: boundedRemaining > 0 ? processed + 1 : summary.initialTotal,
    total: summary.initialTotal,
    processed,
    remaining: boundedRemaining,
  };
}

export function reviewedTotal(summary: ReviewSessionSummary): number {
  return summary.reviewedItemIds.length;
}
