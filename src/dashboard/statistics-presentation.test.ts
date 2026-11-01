// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { LearningStatistics } from '../database/statistics';
import {
  computeCalendarLevel,
  statisticsActivity,
  statisticsCalendar,
} from './statistics-presentation';

function activity(days: LearningStatistics['days']): LearningStatistics {
  return {
    days,
    reviewCount: days.reduce((total, day) => total + day.reviews, 0),
    reviewedItems: 0,
    activeDays: days.filter((day) => day.reviews > 0).length,
    newItems: 0,
    ratings: { 1: 0, 2: 0, 3: 0, 4: 0 },
  };
}

describe('statistics presentation', () => {
  it('keeps the selected range continuous across a year boundary without changing its buckets', () => {
    const days = [
      { date: '2026-12-30', reviews: 1 },
      { date: '2026-12-31', reviews: 0 },
      { date: '2027-01-01', reviews: 3 },
      { date: '2027-01-02', reviews: 2 },
    ];
    const before = structuredClone(days);
    const calendar = statisticsCalendar(days);
    expect(calendar).toEqual({ label: '2026年12月—2027年1月', offset: 2, days });
    expect(calendar.days).toBe(days);
    expect(days).toEqual(before);
  });

  it('labels a single month and aligns Monday and Sunday to the existing weekday headings', () => {
    const days = [
      { date: '2026-10-05', reviews: 0 },
      { date: '2026-10-06', reviews: 3 },
    ];
    expect(statisticsCalendar(days)).toEqual({ label: '2026年10月', offset: 0, days });
    expect(statisticsCalendar([{ date: '2026-10-04', reviews: 0 }]).offset).toBe(6);
  });

  it('keeps leap day and a same-year month transition in the same grid', () => {
    const days = [
      { date: '2028-02-28', reviews: 1 },
      { date: '2028-02-29', reviews: 0 },
      { date: '2028-03-01', reviews: 1 },
    ];
    expect(statisticsCalendar(days)).toEqual({ label: '2028年2月—3月', offset: 0, days });
  });

  it.each([
    ['2026-03-28', '2026-03-29', '2026-03-30'],
    ['2026-10-24', '2026-10-25', '2026-10-26'],
  ])('preserves local dates across a daylight-saving transition starting %s', (...dates) => {
    const days = dates.map((date, index) => ({ date, reviews: index }));
    const calendar = statisticsCalendar(days);
    expect(calendar.offset).toBe(5);
    expect(calendar.days).toBe(days);
    expect(calendar.days.map((day) => day.date)).toEqual(dates);
  });

  it('handles an empty range without inventing a date or activity', () => {
    expect(statisticsCalendar([])).toEqual({ label: '暂无日期', offset: 0, days: [] });
  });

  it.each([
    [0, 0],
    [1, 1],
    [4, 1],
    [5, 2],
    [9, 2],
    [10, 3],
    [19, 3],
    [20, 4],
    [500, 4],
  ])('assigns %i reviews to fixed shade %i', (reviews, level) => {
    expect(computeCalendarLevel(reviews)).toBe(level);
  });

  it('counts active days, not reviews, and breaks runs on inactive or missing dates', () => {
    const data = activity([
      { date: '2026-09-28', reviews: 40 },
      { date: '2026-09-29', reviews: 2 },
      { date: '2026-09-30', reviews: 0 },
      { date: '2026-10-01', reviews: 1 },
      { date: '2026-10-03', reviews: 4 },
      { date: '2026-10-04', reviews: 0 },
    ]);
    const before = structuredClone(data);
    expect(statisticsActivity(data)).toEqual({ longestRun: 2 });
    expect(data).toEqual(before);
  });

  it.each([
    ['2026-12-31', '2027-01-01', '2027-01-02'],
    ['2028-02-28', '2028-02-29', '2028-03-01'],
    ['2026-03-28', '2026-03-29', '2026-03-30'],
    ['2026-10-24', '2026-10-25', '2026-10-26'],
  ])('counts consecutive calendar days across %s through %s', (...dates) => {
    expect(statisticsActivity(activity(dates.map((date) => ({ date, reviews: 1 }))))).toEqual({
      longestRun: 3,
    });
  });

  it('reports no activity for an empty or inactive range', () => {
    expect(statisticsActivity(activity([]))).toEqual({ longestRun: 0 });
    expect(statisticsActivity(activity([{ date: '2026-10-04', reviews: 0 }]))).toEqual({
      longestRun: 0,
    });
  });
});
