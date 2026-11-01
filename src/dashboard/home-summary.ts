import type { LearningItem } from '../database';

export interface DashboardHomeSummary {
  dueCount: number;
  reviewsCompletedToday: number;
  recentCaptures: LearningItem[];
  upcomingReviews: LearningItem[];
}

export interface DashboardHomeSummaryOptions {
  recentLimit?: number;
  upcomingLimit?: number;
}

const DEFAULT_RECENT_LIMIT = 4;
const DEFAULT_UPCOMING_LIMIT = 4;

/** Builds a dashboard projection without changing items, cards, or review histories. */
export function buildDashboardHomeSummary(
  items: readonly LearningItem[],
  now: Date,
  options: DashboardHomeSummaryOptions = {},
): DashboardHomeSummary {
  const nowTime = now.getTime();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
  const todayStartTime = startOfToday.getTime();
  const tomorrowStartTime = startOfTomorrow.getTime();

  return {
    dueCount: items.filter((item) => !item.suspended && item.fsrsCard.due.getTime() <= nowTime)
      .length,
    reviewsCompletedToday: items.reduce(
      (count, item) =>
        count +
        item.reviewHistory.filter((review) => {
          const reviewedAt = review.reviewedAt.getTime();
          return reviewedAt >= todayStartTime && reviewedAt < tomorrowStartTime;
        }).length,
      0,
    ),
    recentCaptures: [...items]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, normalizedLimit(options.recentLimit, DEFAULT_RECENT_LIMIT)),
    upcomingReviews: items
      .filter((item) => !item.suspended && item.fsrsCard.due.getTime() > nowTime)
      .sort((left, right) => left.fsrsCard.due.getTime() - right.fsrsCard.due.getTime())
      .slice(0, normalizedLimit(options.upcomingLimit, DEFAULT_UPCOMING_LIMIT)),
  };
}

function normalizedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}
