import { State } from 'ts-fsrs';

import type { LearningItem } from '../database';
import type { VideoPlatform } from '../models/platform';

export const HOME_UPCOMING_QUERY_LIMIT = 60;
export const HOME_COHORT_PREVIEW_LIMIT = 3;
export const COHORT_INITIAL_ITEM_LIMIT = 5;
export const COHORT_ITEM_INCREMENT = 10;
export const UPCOMING_PAGE_SIZE = 50;

export type ReviewDateBucket = 'due-now' | 'today' | 'tomorrow' | 'next-seven-days' | 'later';
export type UpcomingRange = '7-days' | '30-days' | 'all';

export interface UpcomingReviewCohort {
  key: string;
  displayedDueMinute: Date;
  earliestDue: Date;
  latestDue: Date;
  itemCount: number;
  itemIds: string[];
  items: LearningItem[];
  stateCounts: Readonly<Record<string, number>>;
  platformCounts: Readonly<Record<VideoPlatform, number>>;
  textCount: number;
  imageCount: number;
}

export interface UpcomingReviewCohortResult {
  cohorts: UpcomingReviewCohort[];
  invalidCount: number;
}

export interface BucketedReviewCohorts {
  key: ReviewDateBucket;
  label: string;
  itemCount: number;
  cohorts: UpcomingReviewCohort[];
}

const BUCKET_ORDER: readonly ReviewDateBucket[] = [
  'due-now',
  'today',
  'tomorrow',
  'next-seven-days',
  'later',
];

const BUCKET_LABELS: Record<ReviewDateBucket, string> = {
  'due-now': '现在到期',
  today: '今天',
  tomorrow: '明天',
  'next-seven-days': '未来 7 天',
  later: '更晚',
};

export function buildUpcomingReviewCohorts(
  values: readonly LearningItem[],
): UpcomingReviewCohortResult {
  const ordered = [...values].sort(compareReviewItems);
  const grouped = new Map<string, LearningItem[]>();
  let invalidCount = 0;

  for (const item of ordered) {
    if (!isValidDate(item.fsrsCard.due)) {
      invalidCount += 1;
      continue;
    }
    const key = localMinuteKey(item.fsrsCard.due);
    const items = grouped.get(key) ?? [];
    items.push(item);
    grouped.set(key, items);
  }

  return {
    cohorts: [...grouped.entries()].map(([key, items]) => createCohort(key, items)),
    invalidCount,
  };
}

export function bucketUpcomingReviewCohorts(
  cohorts: readonly UpcomingReviewCohort[],
  now: Date,
): BucketedReviewCohorts[] {
  const boundaries = localReviewBucketBoundaries(now);
  const buckets = new Map<ReviewDateBucket, UpcomingReviewCohort[]>(
    BUCKET_ORDER.map((key) => [key, []]),
  );

  for (const cohort of cohorts) {
    const due = cohort.earliestDue.getTime();
    let key: ReviewDateBucket;
    if (due <= now.getTime()) key = 'due-now';
    else if (due < boundaries.tomorrow.getTime()) key = 'today';
    else if (due < boundaries.afterTomorrow.getTime()) key = 'tomorrow';
    else if (due < boundaries.afterNextSevenDays.getTime()) key = 'next-seven-days';
    else key = 'later';
    buckets.get(key)!.push(cohort);
  }

  return BUCKET_ORDER.map((key) => {
    const values = buckets.get(key)!;
    return {
      key,
      label: BUCKET_LABELS[key],
      itemCount: values.reduce((total, cohort) => total + cohort.itemCount, 0),
      cohorts: values,
    };
  });
}

export function localReviewBucketBoundaries(now: Date): {
  today: Date;
  tomorrow: Date;
  afterTomorrow: Date;
  afterNextSevenDays: Date;
} {
  assertDate(now, 'now');
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const tomorrow = addLocalDays(today, 1);
  const afterTomorrow = addLocalDays(today, 2);
  const afterNextSevenDays = addLocalDays(afterTomorrow, 7);
  return { today, tomorrow, afterTomorrow, afterNextSevenDays };
}

export function rangeEnd(now: Date, range: UpcomingRange): Date | undefined {
  assertDate(now, 'now');
  if (range === 'all') return undefined;
  const end = new Date(now);
  end.setDate(end.getDate() + (range === '7-days' ? 7 : 30));
  return end;
}

export function formatReviewRelative(due: Date, now: Date): string {
  assertDate(due, 'due');
  assertDate(now, 'now');
  const delta = due.getTime() - now.getTime();
  if (delta <= 0) return '现在到期';

  const minutes = Math.max(1, Math.ceil(delta / 60_000));
  if (minutes < 60) return `${minutes} 分钟后`;

  const boundaries = localReviewBucketBoundaries(now);
  if (due.getTime() < boundaries.tomorrow.getTime()) {
    return `今天 ${formatClockTime(due)}`;
  }
  if (due.getTime() < boundaries.afterTomorrow.getTime()) {
    return `明天 ${formatClockTime(due)}`;
  }
  if (due.getTime() < addLocalDays(boundaries.today, 7).getTime()) {
    return `${new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(
      due,
    )} ${formatClockTime(due)}`;
  }
  return `${new Intl.DateTimeFormat('zh-CN', {
    day: 'numeric',
    month: 'long',
  }).format(due)} ${formatClockTime(due)}`;
}

export function formatReviewExact(due: Date, now: Date): string {
  assertDate(due, 'due');
  assertDate(now, 'now');
  const boundaries = localReviewBucketBoundaries(now);
  if (
    due.getTime() >= boundaries.today.getTime() &&
    due.getTime() < boundaries.tomorrow.getTime()
  ) {
    return `今天 ${formatClockTime(due)}`;
  }
  if (
    due.getTime() >= boundaries.tomorrow.getTime() &&
    due.getTime() < boundaries.afterTomorrow.getTime()
  ) {
    return `明天 ${formatClockTime(due)}`;
  }
  return new Intl.DateTimeFormat('zh-CN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(due);
}

export function formatClockTime(due: Date): string {
  assertDate(due, 'due');
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(due);
}

export function stateLabel(state: State): string {
  switch (state) {
    case State.New:
      return '新卡';
    case State.Learning:
      return '学习中';
    case State.Review:
      return '复习';
    case State.Relearning:
      return '重新学习';
  }
}

function createCohort(key: string, items: LearningItem[]): UpcomingReviewCohort {
  const first = items[0]!;
  let earliestDue = Infinity;
  let latestDue = -Infinity;
  const itemIds: string[] = [];
  const stateCounts: Record<string, number> = {};
  const platformCounts: Record<VideoPlatform, number> = {
    bilibili: 0,
    youtube: 0,
    douyin: 0,
  };
  let textCount = 0;
  let imageCount = 0;
  for (const item of items) {
    const due = item.fsrsCard.due.getTime();
    earliestDue = Math.min(earliestDue, due);
    latestDue = Math.max(latestDue, due);
    itemIds.push(item.id);
    const label = stateLabel(item.fsrsCard.state);
    stateCounts[label] = (stateCounts[label] ?? 0) + 1;
    if (item.sourceType === 'text') textCount += 1;
    else if (item.sourceType === 'image') imageCount += 1;
    else platformCounts[item.platform] += 1;
  }
  return {
    key,
    displayedDueMinute: startOfLocalMinute(first.fsrsCard.due),
    earliestDue: new Date(earliestDue),
    latestDue: new Date(latestDue),
    itemCount: items.length,
    itemIds,
    items,
    stateCounts,
    platformCounts,
    textCount,
    imageCount,
  };
}

function compareReviewItems(left: LearningItem, right: LearningItem): number {
  const leftTime = isValidDate(left.fsrsCard.due)
    ? left.fsrsCard.due.getTime()
    : Number.POSITIVE_INFINITY;
  const rightTime = isValidDate(right.fsrsCard.due)
    ? right.fsrsCard.due.getTime()
    : Number.POSITIVE_INFINITY;
  return leftTime - rightTime || compareStableText(left.id, right.id);
}

function localMinuteKey(date: Date): string {
  return [
    date.getFullYear().toString().padStart(4, '0'),
    (date.getMonth() + 1).toString().padStart(2, '0'),
    date.getDate().toString().padStart(2, '0'),
    date.getHours().toString().padStart(2, '0'),
    date.getMinutes().toString().padStart(2, '0'),
  ].join('-');
}

function startOfLocalMinute(date: Date): Date {
  const value = new Date(date);
  value.setSeconds(0, 0);
  return value;
}

function addLocalDays(value: Date, count: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + count);
  return next;
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function assertDate(value: Date, label: string): void {
  if (!isValidDate(value)) throw new TypeError(`${label} must be a valid Date.`);
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
