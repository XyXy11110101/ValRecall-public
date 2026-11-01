import type {
  ListUpcomingReviewItemsOptions,
  UpcomingReviewItemsPage,
  UpcomingReviewCursor,
} from '../database';

/**
 * Reads enough pages to replace `loadedCount` rows, so a time tick keeps what "load more" brought
 * in. It goes page by page because the repository caps one page, and it stops after a fixed number
 * of pages. Always reads at least one page.
 */
export async function loadUpcomingPages(
  load: (options: ListUpcomingReviewItemsOptions) => Promise<UpcomingReviewItemsPage>,
  options: Omit<ListUpcomingReviewItemsOptions, 'limit' | 'cursor'>,
  pageSize: number,
  loadedCount: number,
): Promise<UpcomingReviewItemsPage> {
  const pageCount = Math.max(1, Math.ceil(loadedCount / pageSize));
  const byId = new Map<string, UpcomingReviewItemsPage['items'][number]>();
  let cursor: UpcomingReviewCursor | null = null;
  let hasMore = false;
  let invalidCount = 0;

  for (let read = 0; read < pageCount; read += 1) {
    const page: UpcomingReviewItemsPage = await load({
      ...options,
      limit: pageSize,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.items) byId.set(item.id, item);
    cursor = page.nextCursor;
    hasMore = page.hasMore;
    invalidCount += page.invalidCount;
    if (!hasMore || !cursor) break;
  }

  return { items: [...byId.values()], nextCursor: cursor, hasMore, invalidCount };
}
