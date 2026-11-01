import { describe, expect, it, vi } from 'vitest';

import type { UpcomingReviewItemsPage } from '../database';
import { loadHomeDashboardData, type HomeDataRepository } from './home-data';

const now = new Date(2026, 6, 21, 12);

describe('loadHomeDashboardData', () => {
  it('uses only bounded/indexed projections and derives an exact 24-hour count', async () => {
    const upcoming: UpcomingReviewItemsPage = {
      items: [],
      nextCursor: null,
      hasMore: false,
      invalidCount: 0,
    };
    const repository: HomeDataRepository = {
      countDueReviewItems: vi.fn().mockResolvedValue(3),
      countReviewsBetween: vi.fn().mockResolvedValue(4),
      listRecentItems: vi.fn().mockResolvedValue([]),
      listUpcomingReviewItems: vi.fn().mockResolvedValue(upcoming),
    };

    await expect(loadHomeDashboardData(repository, now)).resolves.toEqual({
      dueCount: 3,
      reviewsCompletedToday: 4,
      recentCaptures: [],
      upcoming,
      next24HourTotal: 0,
    });
    expect(repository.listRecentItems).toHaveBeenCalledWith(4);
    expect(repository.listUpcomingReviewItems).toHaveBeenCalledWith({
      after: now,
      limit: 60,
    });
    expect('listItems' in repository).toBe(false);
  });

  it('omits the 24-hour total when a bounded page ends inside that window', async () => {
    const repository = {
      countDueReviewItems: vi.fn().mockResolvedValue(0),
      countReviewsBetween: vi.fn().mockResolvedValue(0),
      listRecentItems: vi.fn().mockResolvedValue([]),
      listUpcomingReviewItems: vi.fn().mockResolvedValue({
        items: [minimalItem(new Date(2026, 6, 21, 13))],
        nextCursor: { due: new Date(2026, 6, 21, 13).toISOString(), itemId: 'item' },
        hasMore: true,
        invalidCount: 0,
      }),
    } satisfies HomeDataRepository;

    const result = await loadHomeDashboardData(repository, now);
    expect(result.next24HourTotal).toBeNull();
  });
});

function minimalItem(due: Date) {
  return {
    id: 'item',
    fsrsCard: { due },
  } as Awaited<ReturnType<HomeDataRepository['listRecentItems']>>[number];
}
