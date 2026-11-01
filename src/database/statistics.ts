import { localDateKey } from '../models/daily-task';

export type StatisticsDays = 7 | 30 | 90;
export interface LearningStatistics {
  days: { date: string; reviews: number }[];
  reviewCount: number;
  reviewedItems: number;
  activeDays: number;
  newItems: number;
  ratings: Record<1 | 2 | 3 | 4, number>;
}

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('学习统计记录格式无效。');
  return value as Record<string, unknown>;
}

function dateValue(value: unknown): Date {
  const date = typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
  if (!Number.isFinite(date.getTime())) throw new Error('学习统计记录日期无效。');
  return date;
}

export function statisticsAccumulator(days: StatisticsDays, now: Date) {
  if (![7, 30, 90].includes(days) || !Number.isFinite(now.getTime())) {
    throw new Error('学习统计范围无效。');
  }
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 1);
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  const daily = new Map<string, number>();
  for (const date = new Date(start); date < end; date.setDate(date.getDate() + 1)) {
    daily.set(localDateKey(date), 0);
  }
  const itemIds = new Set<string>();
  const reviewedIds = new Set<string>();
  const ratings: LearningStatistics['ratings'] = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let newItems = 0;
  let reviewCount = 0;
  return {
    item(value: unknown) {
      const item = row(value);
      if (typeof item.id !== 'string') throw new Error('学习统计条目标识无效。');
      itemIds.add(item.id);
      const created = dateValue(item.createdAt);
      if (created >= start && created < end) newItems++;
    },
    review(value: unknown) {
      const review = row(value);
      const at = dateValue(review.reviewedAt);
      if (at < start || at >= end) return;
      if (typeof review.itemId !== 'string') throw new Error('学习统计复习标识无效。');
      if (!itemIds.has(review.itemId)) return;
      const rating = row(review.log).rating;
      if (rating !== 1 && rating !== 2 && rating !== 3 && rating !== 4) {
        throw new Error('学习统计评分无效。');
      }
      ratings[rating]++;
      reviewedIds.add(review.itemId);
      reviewCount++;
      const key = localDateKey(at);
      daily.set(key, (daily.get(key) ?? 0) + 1);
    },
    result(): LearningStatistics {
      return {
        days: [...daily].map(([date, reviews]) => ({ date, reviews })),
        reviewCount,
        reviewedItems: reviewedIds.size,
        activeDays: [...daily.values()].filter((count) => count > 0).length,
        newItems,
        ratings: { ...ratings },
      };
    },
  };
}

export function scanStatisticsRows(store: IDBObjectStore, visit: (value: unknown) => void) {
  return new Promise<void>((resolve, reject) => {
    const request = store.openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      try {
        visit(cursor.value as unknown);
        cursor.continue();
      } catch (error) {
        reject(error);
      }
    };
  });
}
