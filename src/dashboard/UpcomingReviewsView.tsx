import { sourceLabel } from '../shared/source-labels';
import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  LearningItem,
  ListUpcomingReviewItemsOptions,
  UpcomingReviewCursor,
  UpcomingReviewItemsPage,
  VideoLearningItem,
} from '../database';
import { learningItemSource, learningItemTitle } from '../database';
import type { ReminderStatusResponse } from '../models/messages';
import { Notice } from '../shared/components';
import { displayError, getReminderStatus, openSourceAtTimestamp } from '../shared/extension';
import type { ValRecallPreferences } from '../shared/preferences';
import { MotionDisclosure } from '../ui/motion';
import { repository } from './services';
import { formatReminderStatus } from './UpcomingReviewsCard';
import {
  buildUpcomingReviewCohorts,
  bucketUpcomingReviewCohorts,
  COHORT_INITIAL_ITEM_LIMIT,
  COHORT_ITEM_INCREMENT,
  formatClockTime,
  formatReviewExact,
  rangeEnd,
  stateLabel,
  type ReviewDateBucket,
  type UpcomingRange,
  UPCOMING_PAGE_SIZE,
} from './upcoming-reviews';
import { useMinuteClock } from './useMinuteClock';

export type UpcomingReviewLoader = (
  options: ListUpcomingReviewItemsOptions,
) => Promise<UpcomingReviewItemsPage>;
export type DueReviewCountLoader = (now: Date) => Promise<number>;

const loadRepositoryUpcoming: UpcomingReviewLoader = (options) =>
  repository.listUpcomingReviewItems(options);
const loadRepositoryDueCount: DueReviewCountLoader = (now) => repository.countDueReviewItems(now);
const systemClock = () => new Date();

export function UpcomingReviewsView({
  revision,
  preferences,
  onViewItem,
  onOpenReminderSettings,
  loadUpcoming = loadRepositoryUpcoming,
  loadDueCount = loadRepositoryDueCount,
  reminderStatusLoader = getReminderStatus,
  clock = systemClock,
}: {
  revision: number;
  preferences: ValRecallPreferences;
  onViewItem: (item: LearningItem) => void;
  onOpenReminderSettings: () => void;
  loadUpcoming?: UpcomingReviewLoader;
  loadDueCount?: DueReviewCountLoader;
  reminderStatusLoader?: () => Promise<ReminderStatusResponse>;
  clock?: () => Date;
}) {
  const now = useMinuteClock(clock);
  const [range, setRange] = useState<UpcomingRange>('7-days');
  const [items, setItems] = useState<LearningItem[]>([]);
  const [cursor, setCursor] = useState<UpcomingReviewCursor | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [invalidCount, setInvalidCount] = useState(0);
  const [dueCount, setDueCount] = useState(0);
  const [queryAfter, setQueryAfter] = useState(() => new Date(now));
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [openBuckets, setOpenBuckets] = useState<Set<ReviewDateBucket>>(new Set());
  const [expandedCohort, setExpandedCohort] = useState<string | null>(null);
  const [visibleItemCounts, setVisibleItemCounts] = useState<Record<string, number>>({});
  const [reminderStatus, setReminderStatus] = useState<ReminderStatusResponse | null>(null);
  const [notice, setNotice] = useState<{
    tone: 'success' | 'warning' | 'error';
    text: string;
  } | null>(null);
  const requestSequenceRef = useRef(0);
  const loadedRef = useRef(false);
  const rangeBefore = rangeEnd(queryAfter, range);

  useEffect(() => {
    const sequence = ++requestSequenceRef.current;
    const after = new Date(now);
    const before = rangeEnd(after, range);
    if (loadedRef.current) setRefreshing(true);
    else setLoading(true);
    setNotice(null);
    setExpandedCohort(null);
    setVisibleItemCounts({});
    void Promise.all([
      loadUpcoming({
        after,
        ...(before ? { before } : {}),
        limit: UPCOMING_PAGE_SIZE,
      }),
      loadDueCount(after),
      reminderStatusLoader(),
    ])
      .then(([page, currentDueCount, status]) => {
        if (requestSequenceRef.current !== sequence) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
        setInvalidCount(page.invalidCount);
        setDueCount(currentDueCount);
        setReminderStatus(status);
        setQueryAfter(after);
        loadedRef.current = true;
      })
      .catch((error: unknown) => {
        if (requestSequenceRef.current !== sequence) return;
        setNotice({
          tone: 'error',
          text: displayError(error, '即将到期的复习无法加载。'),
        });
      })
      .finally(() => {
        if (requestSequenceRef.current !== sequence) return;
        setLoading(false);
        setRefreshing(false);
      });
  }, [loadDueCount, loadUpcoming, now, range, reminderStatusLoader, revision]);

  const cohortResult = useMemo(() => buildUpcomingReviewCohorts(items), [items]);
  const buckets = useMemo(
    () => bucketUpcomingReviewCohorts(cohortResult.cohorts, now),
    [cohortResult.cohorts, now],
  );
  const partialCohortKey = hasMore ? (cohortResult.cohorts.at(-1)?.key ?? null) : null;
  const visibleBuckets = buckets.filter((bucket) => bucket.key !== 'due-now');
  const totalFuture = items.length;

  useEffect(() => {
    if (openBuckets.size > 0 || totalFuture === 0) return;
    const defaults = new Set<ReviewDateBucket>();
    const today = visibleBuckets.find((bucket) => bucket.key === 'today');
    const tomorrow = visibleBuckets.find((bucket) => bucket.key === 'tomorrow');
    if (today && today.itemCount > 0) defaults.add('today');
    if (totalFuture <= 12 && tomorrow && tomorrow.itemCount > 0) defaults.add('tomorrow');
    setOpenBuckets(defaults);
  }, [openBuckets.size, totalFuture, visibleBuckets]);

  async function loadMore() {
    if (!cursor || loadingMore || !hasMore) return;
    setLoadingMore(true);
    const sequence = requestSequenceRef.current;
    try {
      const page = await loadUpcoming({
        after: queryAfter,
        ...(rangeBefore ? { before: rangeBefore } : {}),
        limit: UPCOMING_PAGE_SIZE,
        cursor,
      });
      if (requestSequenceRef.current !== sequence) return;
      setItems((current) => mergeStableItems(current, page.items));
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
      setInvalidCount((current) => current + page.invalidCount);
    } catch (error) {
      setNotice({
        tone: 'error',
        text: displayError(error, '无法加载更多即将到期的复习。'),
      });
    } finally {
      if (requestSequenceRef.current === sequence) setLoadingMore(false);
    }
  }

  async function openSource(item: VideoLearningItem) {
    const result = await openSourceAtTimestamp({
      platform: item.platform,
      sourceUrl: item.sourceUrl,
      canonicalUrl: item.canonicalUrl,
      timestampSeconds: item.timestampSeconds,
      pauseAfterSeek: preferences.pauseAfterReopen,
    });
    setNotice({
      tone: result.ok ? 'success' : 'warning',
      text: result.ok
        ? item.timestampDisplay
          ? `已打开「${item.videoTitle}」，定位到 ${item.timestampDisplay}。`
          : `已打开「${item.videoTitle}」。`
        : item.timestampDisplay
          ? `已打开，请手动跳到 ${item.timestampDisplay}。`
          : `来源无法打开。${result.error ?? ''}`,
    });
  }

  function changeRange(next: UpcomingRange) {
    if (next === range) return;
    setOpenBuckets(new Set());
    setRange(next);
  }

  return (
    <section className="stack upcoming-review-view" aria-busy={loading || refreshing}>
      <div className="split upcoming-review-heading">
        <div>
          <p className="eyebrow">复习预告</p>
          <h2 className="dashboard-page-heading" tabIndex={-1}>
            即将到期
          </h2>
        </div>
        <span className="pill">已加载 {items.length} 条</span>
      </div>

      {notice && (
        <div className="motion-state-change" key={`${notice.tone}-${notice.text}`}>
          <Notice tone={notice.tone}>{notice.text}</Notice>
        </div>
      )}

      <div className="upcoming-range-tabs" role="tablist" aria-label="即将到期范围">
        {UPCOMING_RANGES.map((entry) => (
          <button
            className={`button small-button motion-press ${range === entry.id ? '' : 'secondary'}`}
            aria-selected={range === entry.id}
            role="tab"
            key={entry.id}
            onClick={() => changeRange(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="card upcoming-reminder-summary split">
        <div>
          <strong>
            {formatReminderStatus(preferences.nextDueReminderEnabled, reminderStatus, now)}
          </strong>
        </div>
        <button
          className="button secondary small-button motion-press"
          onClick={onOpenReminderSettings}
        >
          提醒设置
        </button>
      </div>

      {dueCount > 0 && <Notice tone="warning">现在有 {dueCount} 条复习可以开始。</Notice>}

      {loading && items.length === 0 ? (
        <div className="card dashboard-loading-state" role="status">
          <span className="motion-loading-indicator" aria-hidden="true" />
          <span>正在加载…</span>
        </div>
      ) : (
        <>
          {refreshing && (
            <div className="dashboard-refresh-status" role="status">
              <span className="motion-loading-indicator" aria-hidden="true" />
              <span>正在刷新…</span>
            </div>
          )}
          {totalFuture === 0 ? (
            <div className="empty-state">
              <h3>所选范围内没有复习</h3>
              <p>
                {dueCount > 0
                  ? '这个范围内没有更晚的复习安排。'
                  : range === '7-days'
                    ? '未来 7 天没有复习。'
                    : '保存一条学习 Moment 即可开始。'}
              </p>
            </div>
          ) : (
            <div className="upcoming-bucket-list">
              {visibleBuckets.map((bucket) => {
                const open = openBuckets.has(bucket.key);
                const bucketMayBePartial = bucket.cohorts.some(
                  (cohort) => cohort.key === partialCohortKey,
                );
                return (
                  <section className="card upcoming-bucket" key={bucket.key}>
                    <button
                      className="upcoming-bucket-button motion-press"
                      aria-expanded={open}
                      aria-controls={`upcoming-bucket-${bucket.key}`}
                      onClick={() =>
                        setOpenBuckets((current) => {
                          const next = new Set(current);
                          if (next.has(bucket.key)) next.delete(bucket.key);
                          else next.add(bucket.key);
                          return next;
                        })
                      }
                    >
                      <span>{bucket.label}</span>
                      <span>
                        {bucket.itemCount}
                        {bucketMayBePartial ? '+' : ''} 条复习
                      </span>
                    </button>
                    <MotionDisclosure
                      open={open}
                      id={`upcoming-bucket-${bucket.key}`}
                      className="upcoming-bucket-disclosure"
                    >
                      {bucket.itemCount === 0 ? (
                        <p className="muted small">这个日期段没有复习。</p>
                      ) : (
                        <ol className="upcoming-cohort-list">
                          {bucket.cohorts.map((cohort) => {
                            const cohortOpen = expandedCohort === cohort.key;
                            const cohortMayBePartial = cohort.key === partialCohortKey;
                            const visibleCount = Math.min(
                              visibleItemCounts[cohort.key] ?? COHORT_INITIAL_ITEM_LIMIT,
                              cohort.itemCount,
                            );
                            return (
                              <li className="upcoming-cohort" key={cohort.key}>
                                <button
                                  className="upcoming-cohort-button motion-press"
                                  aria-expanded={cohortOpen}
                                  onClick={() => {
                                    setExpandedCohort(cohortOpen ? null : cohort.key);
                                    setVisibleItemCounts((current) => ({
                                      ...current,
                                      [cohort.key]:
                                        current[cohort.key] ?? COHORT_INITIAL_ITEM_LIMIT,
                                    }));
                                  }}
                                >
                                  <time dateTime={cohort.earliestDue.toISOString()}>
                                    {formatClockTime(cohort.displayedDueMinute)}
                                  </time>
                                  <span>
                                    {cohort.itemCount}
                                    {cohortMayBePartial ? '+' : ''} 条
                                  </span>
                                </button>
                                {cohortOpen && (
                                  <div className="upcoming-cohort-items motion-reveal">
                                    <ol>
                                      {cohort.items.slice(0, visibleCount).map((item) => (
                                        <li className="upcoming-item-row" key={item.id}>
                                          <div>
                                            <span className="platform-label">
                                              {sourceLabel(learningItemSource(item))}
                                            </span>
                                            <strong title={learningItemTitle(item)}>
                                              {learningItemTitle(item)}
                                            </strong>
                                            <span className="muted small upcoming-question-excerpt">
                                              {conciseExcerpt(item.recallPrompt)}
                                            </span>
                                          </div>
                                          <div className="upcoming-item-meta">
                                            <span>{stateLabel(item.fsrsCard.state)}</span>
                                            <time dateTime={item.fsrsCard.due.toISOString()}>
                                              {formatReviewExact(item.fsrsCard.due, now)}
                                            </time>
                                          </div>
                                          <div className="cluster upcoming-item-actions">
                                            {item.sourceType !== 'text' &&
                                              item.sourceType !== 'image' && (
                                                <button
                                                  className="button secondary small-button motion-press"
                                                  onClick={() => void openSource(item)}
                                                >
                                                  打开来源
                                                </button>
                                              )}
                                            <button
                                              className="button secondary small-button motion-press"
                                              onClick={() => onViewItem(item)}
                                            >
                                              查看或编辑
                                            </button>
                                          </div>
                                        </li>
                                      ))}
                                    </ol>
                                    <div className="cluster">
                                      {visibleCount < cohort.itemCount && (
                                        <button
                                          className="button secondary small-button motion-press"
                                          onClick={() =>
                                            setVisibleItemCounts((current) => ({
                                              ...current,
                                              [cohort.key]: Math.min(
                                                cohort.itemCount,
                                                visibleCount + COHORT_ITEM_INCREMENT,
                                              ),
                                            }))
                                          }
                                        >
                                          再显示{' '}
                                          {Math.min(
                                            COHORT_ITEM_INCREMENT,
                                            cohort.itemCount - visibleCount,
                                          )}{' '}
                                          条
                                        </button>
                                      )}
                                      {visibleCount > COHORT_INITIAL_ITEM_LIMIT && (
                                        <button
                                          className="button secondary small-button motion-press"
                                          onClick={() =>
                                            setVisibleItemCounts((current) => ({
                                              ...current,
                                              [cohort.key]: COHORT_INITIAL_ITEM_LIMIT,
                                            }))
                                          }
                                        >
                                          收起
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </li>
                            );
                          })}
                        </ol>
                      )}
                    </MotionDisclosure>
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}

      {invalidCount + cohortResult.invalidCount > 0 && (
        <Notice tone="warning">{invalidCount + cohortResult.invalidCount} 条记录读取失败。</Notice>
      )}

      <div className="split upcoming-pagination">
        <span className="muted small">
          已加载 {items.length} 条复习{hasMore ? '；还有更多' : ''}
        </span>
        {hasMore && cursor && (
          <button
            className="button secondary motion-press"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? '加载中…' : '加载更多'}
          </button>
        )}
      </div>
    </section>
  );
}

const UPCOMING_RANGES: ReadonlyArray<{ id: UpcomingRange; label: string }> = [
  { id: '7-days', label: '7 天' },
  { id: '30-days', label: '30 天' },
  { id: 'all', label: '全部' },
];

function mergeStableItems(
  current: readonly LearningItem[],
  incoming: readonly LearningItem[],
): LearningItem[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort(
    (left, right) =>
      left.fsrsCard.due.getTime() - right.fsrsCard.due.getTime() ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
}

function conciseExcerpt(value: string): string {
  const compact = value.trim().replace(/\s+/g, ' ');
  return compact.length <= 96 ? compact : `${compact.slice(0, 93)}…`;
}
