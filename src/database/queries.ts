import { DatabaseError } from './errors';
import { itemFromPersisted } from './mappers';
import type { LearningItem, UpcomingReviewCursor, UpcomingReviewItemsPage } from './types';
const MAX_UPCOMING_REVIEW_PAGE_SIZE = 100;

export function validQueryDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new DatabaseError('INVALID_DATA', `Upcoming review ${label} must be a valid Date.`);
  }
  return new Date(value);
}

export function validUpcomingLimit(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_UPCOMING_REVIEW_PAGE_SIZE) {
    throw new DatabaseError(
      'INVALID_DATA',
      `Upcoming review limit must be an integer from 1 to ${MAX_UPCOMING_REVIEW_PAGE_SIZE}.`,
    );
  }
  return value;
}

export function validUpcomingCursor(value: UpcomingReviewCursor): UpcomingReviewCursor {
  const due = new Date(value.due);
  if (
    !Number.isFinite(due.getTime()) ||
    due.toISOString() !== value.due ||
    typeof value.itemId !== 'string' ||
    !value.itemId
  ) {
    throw new DatabaseError('INVALID_DATA', 'Upcoming review cursor is invalid.');
  }
  return { due: value.due, itemId: value.itemId };
}

interface UpcomingPageCollectionOptions {
  after: Date;
  before: Date | null;
  limit: number;
  continuation: UpcomingReviewCursor | null;
}

export function collectUpcomingReviewPage(
  index: IDBIndex,
  range: IDBKeyRange,
  options: UpcomingPageCollectionOptions,
): Promise<UpcomingReviewItemsPage> {
  return new Promise<UpcomingReviewItemsPage>((resolve, reject) => {
    const request = index.openCursor(range, 'next');
    const items: LearningItem[] = [];
    let invalidCount = 0;

    request.addEventListener('error', () => reject(request.error), { once: true });
    request.addEventListener('success', () => {
      const cursor = request.result;
      if (!cursor) {
        resolve({ items, nextCursor: null, hasMore: false, invalidCount });
        return;
      }

      const dueKey = typeof cursor.key === 'string' ? cursor.key : null;
      const itemId = typeof cursor.primaryKey === 'string' ? cursor.primaryKey : null;
      if (dueKey === null || itemId === null) {
        invalidCount += 1;
        cursor.continue();
        return;
      }
      if (
        options.continuation !== null &&
        dueKey === options.continuation.due &&
        itemId <= options.continuation.itemId
      ) {
        cursor.continue();
        return;
      }

      try {
        const item = itemFromPersisted(cursor.value);
        const dueTime = item.fsrsCard.due.getTime();
        if (
          !item.suspended &&
          dueTime > options.after.getTime() &&
          (options.before === null || dueTime < options.before.getTime())
        ) {
          items.push(item);
        }
      } catch {
        invalidCount += 1;
      }

      if (items.length > options.limit) {
        items.pop();
        const last = items.at(-1);
        resolve({
          items,
          nextCursor: last ? { due: last.fsrsCard.due.toISOString(), itemId: last.id } : null,
          hasMore: true,
          invalidCount,
        });
        return;
      }
      cursor.continue();
    });
  });
}

export function countActiveItemsInIndexRange(
  index: IDBIndex,
  range: IDBKeyRange,
  categoryId?: string | null,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const request = index.openCursor(range, 'next');
    let count = 0;
    request.addEventListener('error', () => reject(request.error), { once: true });
    request.addEventListener('success', () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(count);
        return;
      }
      try {
        const item = itemFromPersisted(cursor.value);
        if (!item.suspended && (categoryId === undefined || item.categoryId === categoryId)) {
          count += 1;
        }
      } catch {
        // Invalid persisted records are excluded from operational due counts.
      }
      cursor.continue();
    });
  });
}

export function collectRecentItems(index: IDBIndex, limit: number): Promise<LearningItem[]> {
  return new Promise<LearningItem[]>((resolve, reject) => {
    const request = index.openCursor(undefined, 'prev');
    const items: LearningItem[] = [];
    request.addEventListener('error', () => reject(request.error), { once: true });
    request.addEventListener('success', () => {
      const cursor = request.result;
      if (!cursor || items.length >= limit) {
        resolve(items);
        return;
      }
      try {
        items.push(itemFromPersisted(cursor.value));
      } catch {
        // Keep bounded Home summaries usable when one record needs diagnostics.
      }
      cursor.continue();
    });
  });
}

export function countReviewRowsBetween(
  store: IDBObjectStore,
  afterTime: number,
  beforeTime: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const request = store.openCursor();
    let count = 0;
    request.addEventListener('error', () => reject(request.error), { once: true });
    request.addEventListener('success', () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(count);
        return;
      }
      const value =
        typeof cursor.value === 'object' && cursor.value !== null
          ? (cursor.value as { reviewedAt?: unknown })
          : null;
      const reviewedAt =
        typeof value?.reviewedAt === 'string' ? new Date(value.reviewedAt).getTime() : Number.NaN;
      if (Number.isFinite(reviewedAt) && reviewedAt >= afterTime && reviewedAt < beforeTime) {
        count += 1;
      }
      cursor.continue();
    });
  });
}
