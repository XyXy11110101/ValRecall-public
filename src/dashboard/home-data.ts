import type { LearningItem, UpcomingReviewItemsPage } from '../database';
import { HOME_UPCOMING_QUERY_LIMIT } from './upcoming-reviews';

export interface HomeDashboardData {
  dueCount: number;
  reviewsCompletedToday: number;
  recentCaptures: LearningItem[];
  upcoming: UpcomingReviewItemsPage;
  next24HourTotal: number | null;
}

export interface HomeDataRepository {
  countDueReviewItems(now: Date): Promise<number>;
  countReviewsBetween(after: Date, before: Date): Promise<number>;
  listRecentItems(limit: number): Promise<LearningItem[]>;
  listUpcomingReviewItems(options: {
    after: Date;
    limit: number;
  }): Promise<UpcomingReviewItemsPage>;
}

export async function loadHomeDashboardData(
  repository: HomeDataRepository,
  now: Date,
): Promise<HomeDashboardData> {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
  const next24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const [dueCount, reviewsCompletedToday, recentCaptures, upcoming] = await Promise.all([
    repository.countDueReviewItems(now),
    repository.countReviewsBetween(startOfToday, startOfTomorrow),
    repository.listRecentItems(4),
    repository.listUpcomingReviewItems({
      after: now,
      limit: HOME_UPCOMING_QUERY_LIMIT,
    }),
  ]);
  const lastLoadedDue = upcoming.items.at(-1)?.fsrsCard.due.getTime() ?? null;
  const next24HourTotal =
    !upcoming.hasMore || (lastLoadedDue !== null && lastLoadedDue >= next24Hours.getTime())
      ? upcoming.items.filter((item) => item.fsrsCard.due.getTime() < next24Hours.getTime()).length
      : null;

  return {
    dueCount,
    reviewsCompletedToday,
    recentCaptures,
    upcoming,
    next24HourTotal,
  };
}
