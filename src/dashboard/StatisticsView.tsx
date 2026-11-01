import { useEffect, useRef, useState } from 'react';
import type { LearningStatistics, StatisticsDays } from '../database/statistics';
import { FSRS_RATING_OPTIONS } from '../fsrs';
import { localDateKey } from '../models/daily-task';
import { Notice } from '../shared/components';
import { displayError } from '../shared/extension';
import { repository } from './services';
import {
  computeCalendarLevel,
  statisticsActivity,
  statisticsCalendar,
} from './statistics-presentation';

export type StatisticsLoader = (days: StatisticsDays, now: Date) => Promise<LearningStatistics>;
const loadStatistics: StatisticsLoader = (days, now) => repository.getLearningStatistics(days, now);
const systemClock = () => new Date();

function useStatistics(
  days: StatisticsDays,
  revision: number,
  load: StatisticsLoader,
  clock: () => Date,
) {
  const [data, setData] = useState<LearningStatistics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const loadedScope = useRef<string | null>(null);
  useEffect(() => {
    let date = localDateKey(clock());
    const focus = () => setRefresh((value) => value + 1);
    const timer = window.setInterval(() => {
      const next = localDateKey(clock());
      if (date !== next) {
        date = next;
        focus();
      }
    }, 60_000);
    window.addEventListener('focus', focus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, [clock]);
  useEffect(() => {
    let active = true;
    const now = clock();
    const scope = `${days}:${localDateKey(now)}`;
    setLoading(true);
    setError(null);
    if (loadedScope.current !== scope) setData(null);
    void load(days, now)
      .then((result) => {
        if (active) {
          loadedScope.current = scope;
          setData(result);
        }
      })
      .catch((caught) => {
        if (active) setError(displayError(caught, '学习统计无法加载。'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [days, revision, load, clock, refresh]);
  return {
    data,
    error,
    // A refresh after a save keeps the current numbers in place; only a first load (or a new
    // range or day, which clears the data) shows the loading line.
    loading: loading && data === null,
    retry: () => setRefresh((value) => value + 1),
  };
}

interface StatisticsProps {
  revision: number;
  load?: StatisticsLoader;
  clock?: () => Date;
}

export function StatisticsView({
  revision,
  load = loadStatistics,
  clock = systemClock,
}: StatisticsProps) {
  const [days, setDays] = useState<StatisticsDays>(30);
  const state = useStatistics(days, revision, load, clock);
  return (
    <section className="statistics-view">
      <header className="statistics-header">
        <h2 className="dashboard-page-heading" tabIndex={-1}>
          学习统计
        </h2>
      </header>
      <div className="statistics-range" role="group" aria-label="统计时间范围">
        {([7, 30, 90] as const).map((range) => (
          <button
            key={range}
            className="button text-button"
            aria-pressed={days === range}
            onClick={() => setDays(range)}
          >
            近 {range} 天
          </button>
        ))}
      </div>
      <StatisticsState {...state} />
      {state.data && <StatisticsContent data={state.data} />}
    </section>
  );
}

function StatisticsState({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error: string | null;
  retry: () => void;
}) {
  return (
    <>
      {loading && <p role="status">正在加载学习统计…</p>}
      {error && (
        <div>
          <Notice tone="error">{error}</Notice>
          <button className="button secondary" onClick={retry}>
            重试统计
          </button>
        </div>
      )}
    </>
  );
}

function StatisticsContent({ data }: { data: LearningStatistics }) {
  const last = data.days.at(-1)?.date;
  const activity = statisticsActivity(data);
  const calendar = statisticsCalendar(data.days);
  return (
    <>
      <section className="statistics-overview" aria-label="学习投入摘要">
        <dl className="statistics-totals">
          <div className="statistics-total-primary">
            <dt>复习次数</dt>
            <dd>
              {data.reviewCount}
              <span>次</span>
            </dd>
          </div>
          <div>
            <dt>复习条数</dt>
            <dd>
              {data.reviewedItems}
              <span>条</span>
            </dd>
          </div>
          <div>
            <dt>活跃天数</dt>
            <dd>
              {data.activeDays}
              <span>/ {data.days.length} 天</span>
            </dd>
          </div>
          <div className="statistics-total-secondary">
            <dt>新增 Moment</dt>
            <dd>
              {data.newItems}
              <span>条</span>
            </dd>
          </div>
        </dl>
        <div className="statistics-insight">
          {data.reviewCount === 0 ? (
            <p>这段时间还没有复习记录。</p>
          ) : (
            <p>
              区间内最长连续复习 <strong>{activity.longestRun} 天</strong>
            </p>
          )}
        </div>
      </section>
      <div className="statistics-breakdown">
        <section className="statistics-section" aria-labelledby="statistics-calendar-heading">
          <div className="statistics-section-heading">
            <div>
              <h3 id="statistics-calendar-heading">回忆的足迹</h3>
            </div>
            <div className="statistics-legend" aria-label="每日复习次数图例">
              {['0', '1–4', '5–9', '10–19', '20+'].map((label, level) => (
                <span key={label}>
                  <i data-level={level} aria-hidden="true" />
                  {label}
                </span>
              ))}
            </div>
          </div>
          <div className="statistics-calendar-panel" aria-label="复习日历">
            <h4>{calendar.label}</h4>
            <div className="statistics-weekdays" aria-hidden="true">
              {['一', '二', '三', '四', '五', '六', '日'].map((day) => (
                <span key={day}>{day}</span>
              ))}
            </div>
            <ol className="statistics-calendar">
              {Array.from({ length: calendar.offset }, (_, index) => (
                <li key={`pad-${index}`} aria-hidden="true" />
              ))}
              {calendar.days.map((day, index) => (
                <li
                  key={day.date}
                  data-level={computeCalendarLevel(day.reviews)}
                  aria-label={`${day.date}：${day.reviews} 次复习${day.date === last ? '，今天' : ''}`}
                  aria-current={day.date === last ? 'date' : undefined}
                >
                  <span className="statistics-calendar-date" aria-hidden="true">
                    {index === 0 || day.date.endsWith('-01')
                      ? `${Number(day.date.slice(5, 7))}/${Number(day.date.slice(8))}`
                      : Number(day.date.slice(8))}
                  </span>
                  <strong
                    className="statistics-calendar-count"
                    data-compact={day.reviews >= 1000 || undefined}
                    aria-hidden="true"
                  >
                    {day.reviews}
                  </strong>
                </li>
              ))}
            </ol>
          </div>
        </section>
        <section
          className="statistics-section statistics-rating-section"
          aria-labelledby="statistics-rating-heading"
        >
          <div>
            <h3 id="statistics-rating-heading">评分分布</h3>
          </div>
          <ul className="statistics-ratings">
            {FSRS_RATING_OPTIONS.map((option) => {
              const count = data.ratings[option.value];
              const percent = data.reviewCount ? Math.round((count / data.reviewCount) * 100) : 0;
              return (
                <li key={option.value} data-rating={option.value}>
                  <div className="split">
                    <span>{option.label}</span>
                    <span>
                      <strong>{count}</strong> 次 <span className="muted">· {percent}%</span>
                    </span>
                  </div>
                  <div className="statistics-track" aria-hidden="true">
                    <span style={{ width: `${percent}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </>
  );
}

export function HomeStatistics({
  revision,
  onOpen,
  load = loadStatistics,
  clock = systemClock,
}: StatisticsProps & { onOpen: () => void }) {
  const state = useStatistics(7, revision, load, clock);
  const max = Math.max(1, ...(state.data?.days.map((day) => day.reviews) ?? []));
  return (
    <section className="home-statistics card" aria-label="近七日学习统计">
      <div className="split">
        <h3>近七日学习</h3>
        <button className="button text-button small-button" onClick={onOpen}>
          查看学习统计
        </button>
      </div>
      <StatisticsState {...state} />
      {state.data && (
        <>
          <p className="statistics-week-summary">
            <strong>{state.data.reviewCount}</strong> 次复习 ·{' '}
            <strong>{state.data.activeDays}</strong> 天活跃
          </p>
          <ol className="statistics-week">
            {state.data.days.map((day) => (
              <li
                key={day.date}
                aria-label={`${day.date}：${day.reviews} 次复习`}
                aria-current={day.date === state.data?.days.at(-1)?.date ? 'date' : undefined}
              >
                <span className="statistics-week-count">{day.reviews}</span>
                <div className="statistics-week-track" aria-hidden="true">
                  <span style={{ height: `${(day.reviews / max) * 100}%` }} />
                </div>
                <span className="muted small">
                  {day.date === state.data?.days.at(-1)?.date
                    ? '今天'
                    : day.date.slice(5).replace('-', '/')}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
