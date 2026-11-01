import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatisticsView, HomeStatistics, type StatisticsLoader } from './StatisticsView';
import { statisticsAccumulator } from '../database/statistics';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const now = new Date(2026, 8, 29, 12);
const clock = () => now;
const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  vi.useRealTimers();
});
const empty = (days: 7 | 30 | 90) => statisticsAccumulator(days, now).result();
const button = (text: string) =>
  [...container.querySelectorAll('button')].find((element) => element.textContent === text)!;
const calendarDays = () => container.querySelectorAll('.statistics-calendar [data-level]');

describe('StatisticsView', () => {
  it('keeps cross-month dates in one calendar with visible month boundaries', async () => {
    const data = empty(90);
    await act(async () =>
      root.render(<StatisticsView revision={0} clock={clock} load={async () => data} />),
    );
    expect(container.querySelectorAll('.statistics-calendar')).toHaveLength(1);
    const cells = [...container.querySelectorAll('.statistics-calendar [data-level]')];
    expect(cells).toHaveLength(90);
    expect(new Set(cells.map((cell) => cell.getAttribute('aria-label'))).size).toBe(90);
    expect(container.querySelector('.statistics-calendar-panel h4')?.textContent).toBe(
      '2026年7月—9月',
    );
    expect(
      container.querySelector('[aria-label="2026-08-01：0 次复习"] .statistics-calendar-date')
        ?.textContent,
    ).toBe('8/1');
  });

  it('shows only the title, the numbers and the calendar, with each day still labelled', async () => {
    const data = empty(30);
    data.days[28]!.reviews = 2;
    Object.assign(data, { reviewCount: 2, reviewedItems: 1, activeDays: 1 });
    await act(async () =>
      root.render(<StatisticsView revision={0} clock={clock} load={async () => data} />),
    );
    const view = container.querySelector('.statistics-view');
    expect(container.querySelector('.dashboard-page-heading')?.getAttribute('tabindex')).toBe('-1');
    for (const removed of ['每一次回忆', '最近一次', '返回首页', '查看日期明细']) {
      expect(view?.textContent).not.toContain(removed);
    }
    expect(view?.textContent).not.toContain(data.days[0]!.date);
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('details')).toBeNull();
    expect(
      [...container.querySelectorAll('.statistics-calendar [data-level]')].every((day) =>
        /^\d{4}-\d{2}-\d{2}：\d+ 次复习/u.test(day.getAttribute('aria-label') ?? ''),
      ),
    ).toBe(true);
  });

  it('shows readable calendar dates/counts, range-limited activity and honest rating proportions', async () => {
    const data = empty(30);
    data.days[26]!.reviews = 3;
    data.days[27]!.reviews = 12;
    data.days[28]!.reviews = 1;
    data.days[29]!.reviews = 0;
    Object.assign(data, {
      reviewCount: 16,
      reviewedItems: 5,
      activeDays: 3,
      newItems: 2,
      ratings: { 1: 2, 2: 2, 3: 12, 4: 0 },
    });
    const load = vi.fn<StatisticsLoader>().mockResolvedValue(data);
    await act(async () => root.render(<StatisticsView revision={0} clock={clock} load={load} />));
    const cells = container.querySelectorAll('.statistics-calendar [data-level]');
    expect(cells).toHaveLength(30);
    const active = container.querySelector('[aria-label="2026-09-27：12 次复习"]');
    expect(active?.getAttribute('data-level')).toBe('3');
    expect(active?.querySelector('strong')?.textContent).toBe('12');
    expect(active?.querySelector('.statistics-calendar-date')?.textContent).toBe('27');
    expect(
      container
        .querySelector('.statistics-calendar [aria-current="date"]')
        ?.getAttribute('aria-label'),
    ).toBe('2026-09-29：0 次复习，今天');
    expect(container.textContent).toContain('区间内最长连续复习 3 天');
    expect(container.querySelectorAll('.statistics-ratings li')[2]?.textContent).toContain(
      'Good12 次 · 75%',
    );
  });

  it('labels today in the home chart and opens statistics without reloading or recording activity', async () => {
    const load = vi.fn<StatisticsLoader>().mockResolvedValue(empty(7));
    const onOpen = vi.fn();
    await act(async () =>
      root.render(<HomeStatistics revision={0} clock={clock} load={load} onOpen={onOpen} />),
    );
    expect(container.querySelector('li[aria-current="date"]')?.textContent).toBe('0今天');
    await act(async () => button('查看学习统计').click());
    expect(onOpen).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
  });

  it('refreshes the home chart in place without a loading line or a second live region', async () => {
    let resolveNext: (value: ReturnType<typeof empty>) => void = () => undefined;
    const load = vi
      .fn<StatisticsLoader>()
      .mockResolvedValueOnce(empty(7))
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveNext = resolve;
          }),
      );
    await act(async () =>
      root.render(
        <HomeStatistics revision={0} clock={clock} load={load} onOpen={() => undefined} />,
      ),
    );
    const summary = container.querySelector('.statistics-week-summary');
    expect(summary).not.toBeNull();
    await act(async () =>
      root.render(
        <HomeStatistics revision={1} clock={clock} load={load} onOpen={() => undefined} />,
      ),
    );
    expect(load).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('正在加载学习统计');
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('.statistics-week-summary')).toBe(summary);
    await act(async () => resolveNext(empty(7)));
    expect(container.querySelector('.statistics-week-summary')).toBe(summary);
  });

  it('defaults to 30 days and does not overwrite a newer range', async () => {
    let resolveOld: (value: ReturnType<typeof empty>) => void = () => undefined;
    const load: StatisticsLoader = vi.fn<StatisticsLoader>((days) =>
      days === 30
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(empty(days)),
    );
    await act(async () => root.render(<StatisticsView revision={0} clock={clock} load={load} />));
    expect(load).toHaveBeenCalledWith(30, now);
    await act(async () => button('近 7 天').click());
    expect(calendarDays()).toHaveLength(7);
    await act(async () => resolveOld(empty(30)));
    expect(calendarDays()).toHaveLength(7);
    expect(container.textContent).toContain('还没有复习记录');
    expect(container.textContent).not.toContain('不代表掌握率');
  });
  it('shows errors without false zero data and retries independently', async () => {
    const load = vi
      .fn<StatisticsLoader>()
      .mockRejectedValueOnce(new Error('test unavailable'))
      .mockResolvedValue(empty(7));
    await act(async () =>
      root.render(
        <HomeStatistics revision={0} clock={clock} load={load} onOpen={() => undefined} />,
      ),
    );
    expect(container.textContent).toContain('test unavailable');
    expect(container.querySelector('ol')).toBeNull();
    await act(async () => button('重试统计').click());
    expect(container.querySelectorAll('li')).toHaveLength(7);
    expect(container.textContent).toContain('0 次复习');
  });
  it('retains a successful result on refresh failure but does not label an old range as current', async () => {
    const load = vi
      .fn<StatisticsLoader>()
      .mockResolvedValueOnce(empty(30))
      .mockRejectedValue(new Error('refresh failed'));
    await act(async () => root.render(<StatisticsView revision={0} clock={clock} load={load} />));
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(container.textContent).toContain('refresh failed');
    expect(calendarDays()).toHaveLength(30);
    await act(async () => button('近 7 天').click());
    expect(calendarDays()).toHaveLength(0);
    expect(container.textContent).toContain('refresh failed');
  });

  it('refreshes on focus, revision and local date change, not every minute', async () => {
    vi.useFakeTimers();
    let current = now;
    const testClock = () => current;
    const load = vi.fn<StatisticsLoader>().mockResolvedValue(empty(7));
    const render = (revision: number) => (
      <HomeStatistics revision={revision} clock={testClock} load={load} onOpen={() => undefined} />
    );
    await act(async () => root.render(render(0)));
    await act(async () => vi.advanceTimersByTime(120_000));
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => window.dispatchEvent(new Event('focus')));
    await act(async () => root.render(render(1)));
    current = new Date(2026, 8, 30);
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(load).toHaveBeenCalledTimes(4);
  });
});
