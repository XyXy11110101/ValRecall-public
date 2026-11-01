import { sourceLabel } from '../shared/source-labels';
import { useMemo, useRef, useState } from 'react';

import { learningItemSource, learningItemTitle } from '../database';
import type { ReminderStatusResponse } from '../models/messages';
import { MotionDisclosure } from '../ui/motion';
import type { HomeDashboardData } from './home-data';
import {
  buildUpcomingReviewCohorts,
  bucketUpcomingReviewCohorts,
  COHORT_INITIAL_ITEM_LIMIT,
  formatClockTime,
  formatReviewExact,
  formatReviewRelative,
  HOME_COHORT_PREVIEW_LIMIT,
} from './upcoming-reviews';

export function UpcomingReviewsCard({
  data,
  now,
  remindersEnabled,
  onViewFullSchedule,
  onOpenReminderSettings,
}: {
  data: HomeDashboardData;
  now: Date;
  remindersEnabled: boolean;
  onViewFullSchedule: () => void;
  onOpenReminderSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [expandedCohort, setExpandedCohort] = useState<string | null>(null);
  const [expandedItemCounts, setExpandedItemCounts] = useState<Record<string, number>>({});
  const disclosureButtonRef = useRef<HTMLButtonElement | null>(null);
  const cohortResult = useMemo(
    () => buildUpcomingReviewCohorts(data.upcoming.items),
    [data.upcoming.items],
  );
  const previewCohorts = useMemo(
    () => cohortResult.cohorts.slice(0, HOME_COHORT_PREVIEW_LIMIT),
    [cohortResult.cohorts],
  );
  const buckets = useMemo(
    () => bucketUpcomingReviewCohorts(previewCohorts, now).filter((bucket) => bucket.itemCount > 0),
    [now, previewCohorts],
  );
  const nextCohort = cohortResult.cohorts[0] ?? null;
  const partialCohortKey = data.upcoming.hasMore
    ? (cohortResult.cohorts.at(-1)?.key ?? null)
    : null;
  const nextCohortIsPartial = nextCohort?.key === partialCohortKey;
  const invalidCount = data.upcoming.invalidCount + cohortResult.invalidCount;
  const nextRelative = nextCohort ? formatReviewRelative(nextCohort.earliestDue, now) : '';
  const nextExact = nextCohort ? formatReviewExact(nextCohort.earliestDue, now) : '';

  return (
    <section
      className="card home-upcoming-card stack-tight"
      aria-labelledby="home-upcoming-heading"
    >
      <h3 id="home-upcoming-heading">即将到期</h3>

      {nextCohort ? (
        <div className="home-upcoming-next">
          <span className="muted small">下次复习</span>
          <strong>{nextRelative}</strong>
          {nextExact !== nextRelative && (
            <time dateTime={nextCohort.earliestDue.toISOString()}>{nextExact}</time>
          )}
          <span>
            {nextCohortIsPartial ? '至少 ' : ''}
            {nextCohort.itemCount} 条 Moment
          </span>
          {data.next24HourTotal !== null && (
            <span className="muted small">未来 24 小时有 {data.next24HourTotal} 条复习</span>
          )}
        </div>
      ) : data.dueCount > 0 ? (
        <div className="home-upcoming-empty">
          <strong>现在有 {data.dueCount} 条复习可以开始</strong>
          <span className="muted small">之后没有已安排的复习。</span>
        </div>
      ) : (
        <div className="home-upcoming-empty">
          <strong>没有已安排的复习</strong>
          <span className="muted small">保存一条学习 Moment 即可开始。</span>
        </div>
      )}

      {invalidCount > 0 && (
        <p className="notice warning small" role="status">
          {invalidCount} 条记录读取失败。
        </p>
      )}

      {nextCohort && (
        <>
          <button
            className="button secondary small-button motion-press home-upcoming-toggle"
            aria-expanded={open}
            aria-controls="home-upcoming-preview"
            ref={disclosureButtonRef}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? '收起' : '显示即将到期'}
          </button>
          <MotionDisclosure
            open={open}
            id="home-upcoming-preview"
            className="home-upcoming-disclosure"
            returnFocusRef={disclosureButtonRef}
          >
            <div className="home-upcoming-buckets">
              {buckets.map((bucket) => (
                <section key={bucket.key} aria-labelledby={`home-bucket-${bucket.key}`}>
                  <h4 id={`home-bucket-${bucket.key}`}>{bucket.label}</h4>
                  <ol className="upcoming-cohort-list">
                    {bucket.cohorts.map((cohort) => {
                      const expanded = expandedCohort === cohort.key;
                      const cohortIsPartial = cohort.key === partialCohortKey;
                      const visibleCount = Math.min(
                        expandedItemCounts[cohort.key] ?? COHORT_INITIAL_ITEM_LIMIT,
                        cohort.itemCount,
                      );
                      const maximumHomeItems = Math.min(10, cohort.itemCount);
                      return (
                        <li className="upcoming-cohort" key={cohort.key}>
                          <button
                            className="upcoming-cohort-button motion-press"
                            aria-expanded={expanded}
                            onClick={() => {
                              setExpandedCohort(expanded ? null : cohort.key);
                              setExpandedItemCounts((current) => ({
                                ...current,
                                [cohort.key]: current[cohort.key] ?? COHORT_INITIAL_ITEM_LIMIT,
                              }));
                            }}
                          >
                            <time dateTime={cohort.earliestDue.toISOString()}>
                              {formatClockTime(cohort.displayedDueMinute)}
                            </time>
                            <span>
                              {cohort.itemCount}
                              {cohortIsPartial ? '+' : ''} 条
                            </span>
                          </button>
                          {expanded && (
                            <div className="upcoming-cohort-items motion-reveal">
                              <ol>
                                {cohort.items.slice(0, visibleCount).map((item) => (
                                  <li key={item.id}>
                                    <span className="platform-label">
                                      {sourceLabel(learningItemSource(item))}
                                    </span>
                                    <span title={learningItemTitle(item)}>
                                      {learningItemTitle(item)}
                                    </span>
                                  </li>
                                ))}
                              </ol>
                              <div className="cluster">
                                {visibleCount < maximumHomeItems && (
                                  <button
                                    className="button secondary small-button motion-press"
                                    onClick={() =>
                                      setExpandedItemCounts((current) => ({
                                        ...current,
                                        [cohort.key]: maximumHomeItems,
                                      }))
                                    }
                                  >
                                    再显示 {maximumHomeItems - visibleCount} 条
                                  </button>
                                )}
                                {visibleCount > COHORT_INITIAL_ITEM_LIMIT && (
                                  <button
                                    className="button secondary small-button motion-press"
                                    onClick={() =>
                                      setExpandedItemCounts((current) => ({
                                        ...current,
                                        [cohort.key]: COHORT_INITIAL_ITEM_LIMIT,
                                      }))
                                    }
                                  >
                                    收起
                                  </button>
                                )}
                                {cohort.itemCount > maximumHomeItems && (
                                  <button
                                    className="button secondary small-button motion-press"
                                    onClick={onViewFullSchedule}
                                  >
                                    查看全部 {cohort.itemCount}
                                    {cohortIsPartial ? '+' : ''}
                                  </button>
                                )}
                              </div>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
            </div>
          </MotionDisclosure>
        </>
      )}

      <div className="cluster home-upcoming-actions">
        <button className="button secondary small-button motion-press" onClick={onViewFullSchedule}>
          查看完整日程
        </button>
        <button
          className="button secondary small-button motion-press"
          onClick={onOpenReminderSettings}
        >
          {remindersEnabled ? '提醒设置' : '开启提醒'}
        </button>
      </div>
    </section>
  );
}

export function formatReminderStatus(
  enabled: boolean,
  response: ReminderStatusResponse | null,
  now: Date,
): string {
  if (!enabled) return '复习通知已关闭';
  if (response === null || !response.ok) return '提醒状态未知';
  if (response.status.notificationPermission !== 'granted') {
    return '通知权限不可用';
  }
  if (response.status.nextReviewReminderAt === null) return '没有已安排的未来复习';
  const scheduled = new Date(response.status.nextReviewReminderAt);
  if (!Number.isFinite(scheduled.getTime())) return '提醒状态未知';
  return `提醒时间：${formatReviewExact(scheduled, now)}`;
}
