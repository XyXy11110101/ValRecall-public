import type { LearningStatistics } from '../database/statistics';
import { localDateKey } from '../models/daily-task';

export interface StatisticsCalendar {
  label: string;
  offset: number;
  days: LearningStatistics['days'];
}

/** Repository day buckets are chronological local dates, including inactive days. */
export function statisticsCalendar(days: LearningStatistics['days']): StatisticsCalendar {
  const first = days[0]?.date;
  const last = days.at(-1)?.date;
  if (!first || !last) return { label: '暂无日期', offset: 0, days };
  const firstYear = first.slice(0, 4);
  const lastYear = last.slice(0, 4);
  let label = `${firstYear}年${Number(first.slice(5, 7))}月`;
  if (first.slice(0, 7) !== last.slice(0, 7)) {
    label += `—${firstYear === lastYear ? '' : `${lastYear}年`}${Number(last.slice(5, 7))}月`;
  }
  return {
    label,
    offset: (new Date(`${first}T12:00:00`).getDay() + 6) % 7,
    days,
  };
}

/** Fixed bins keep calendar shades comparable when changing the displayed range. */
export function computeCalendarLevel(reviews: number): 0 | 1 | 2 | 3 | 4 {
  if (reviews <= 0) return 0;
  if (reviews < 5) return 1;
  if (reviews < 10) return 2;
  if (reviews < 20) return 3;
  return 4;
}

/** This is the longest run inside the selected range, never a reward streak. */
export function statisticsActivity(data: LearningStatistics): { longestRun: number } {
  let nextActiveDate: string | null = null;
  let run = 0;
  let longestRun = 0;
  for (const day of data.days) {
    if (day.reviews <= 0) {
      run = 0;
      nextActiveDate = null;
      continue;
    }
    run = day.date === nextActiveDate ? run + 1 : 1;
    longestRun = Math.max(longestRun, run);
    const next = new Date(`${day.date}T12:00:00`);
    next.setDate(next.getDate() + 1);
    nextActiveDate = localDateKey(next);
  }
  return { longestRun };
}
