import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { State, createEmptyCard } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VideoLearningItem } from '../database';
import type { HomeDashboardData } from './home-data';
import { UpcomingReviewsCard, formatReminderStatus } from './UpcomingReviewsCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = new Date(2026, 6, 21, 12);

describe('UpcomingReviewsCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('is collapsed by default and shows next cohort/count/24-hour summaries', () => {
    act(() => {
      root.render(
        <UpcomingReviewsCard
          data={data([
            item('same-a', new Date(2026, 6, 21, 19, 40, 1)),
            item('same-b', new Date(2026, 6, 21, 19, 40, 50)),
          ])}
          now={now}
          remindersEnabled
          onViewFullSchedule={() => undefined}
          onOpenReminderSettings={() => undefined}
        />,
      );
    });

    expect(container.textContent).toContain('即将到期');
    expect(container.textContent).toContain('今天 19:40');
    expect(container.textContent).toContain('2 条 Moment');
    expect(container.textContent).toContain('未来 24 小时有 2 条复习');
    expect(button('显示即将到期')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Lesson same-a');
    expect(container.querySelector('img')).toBeNull();
  });

  it('leaves out what repeats or belongs in settings', () => {
    act(() => {
      root.render(
        <UpcomingReviewsCard
          data={data([item('later-today', new Date(2026, 6, 21, 19, 40))])}
          now={now}
          remindersEnabled
          onViewFullSchedule={() => undefined}
          onOpenReminderSettings={() => undefined}
        />,
      );
    });
    expect(container.textContent).not.toContain('复习预告');
    expect(container.textContent).not.toContain('条即将到来');
    expect(container.querySelector('.pill')).toBeNull();
    expect(container.querySelector('[data-reminder-status]')).toBeNull();
    // 今天 19:40 twice in a row would say nothing new.
    expect(container.querySelector('.home-upcoming-next strong')?.textContent).toBe('今天 19:40');
    expect(container.querySelector('.home-upcoming-next time')).toBeNull();
    // The way to the settings stays.
    expect(button('提醒设置')).toBeDefined();
  });

  it('keeps the exact time when it adds something to the relative one', () => {
    act(() => {
      root.render(
        <UpcomingReviewsCard
          data={data([item('soon', new Date(2026, 6, 21, 12, 30))])}
          now={now}
          remindersEnabled={false}
          onViewFullSchedule={() => undefined}
          onOpenReminderSettings={() => undefined}
        />,
      );
    });
    expect(container.querySelector('.home-upcoming-next strong')?.textContent).toBe('30 分钟后');
    const exact = container.querySelector('.home-upcoming-next time');
    expect(exact?.textContent).toBe('今天 12:30');
    expect(exact?.getAttribute('dateTime')).toBe(new Date(2026, 6, 21, 12, 30).toISOString());
  });

  it('shows at most three cohorts and five rows before bounded expansion', () => {
    const values = [
      ...Array.from({ length: 8 }, (_, index) =>
        item(`first-${index}`, new Date(2026, 6, 21, 19, 40, index)),
      ),
      item('second', new Date(2026, 6, 21, 20, 10)),
      item('third', new Date(2026, 6, 22, 10, 15)),
      item('fourth', new Date(2026, 6, 23, 10, 15)),
    ];
    const onViewFullSchedule = vi.fn();
    act(() => {
      root.render(
        <UpcomingReviewsCard
          data={data(values)}
          now={now}
          remindersEnabled={false}
          onViewFullSchedule={onViewFullSchedule}
          onOpenReminderSettings={() => undefined}
        />,
      );
    });
    act(() => button('显示即将到期')?.click());

    expect(container.querySelectorAll('.upcoming-cohort')).toHaveLength(3);
    expect(container.textContent).not.toContain('Lesson fourth');
    const firstCohort = container.querySelector<HTMLButtonElement>('.upcoming-cohort-button');
    act(() => firstCohort?.click());
    expect(container.querySelectorAll('.upcoming-cohort-items li')).toHaveLength(5);
    expect(container.textContent).toContain('再显示 3 条');

    act(() => button('再显示 3 条')?.click());
    expect(container.querySelectorAll('.upcoming-cohort-items li')).toHaveLength(8);
    expect(container.textContent).toContain('收起');
    act(() => itemControl('收起')?.click());
    expect(container.querySelectorAll('.upcoming-cohort-items li')).toHaveLength(5);
    expect(container.querySelector('img')).toBeNull();
  });

  it('marks a page-boundary cohort as a lower bound instead of inventing an exact total', () => {
    const boundedData = data(
      Array.from({ length: 60 }, (_, index) =>
        item(`bounded-${index}`, new Date(2026, 6, 21, 19, 40, index % 60)),
      ),
    );
    boundedData.upcoming.hasMore = true;
    boundedData.next24HourTotal = null;
    act(() => {
      root.render(
        <UpcomingReviewsCard
          data={boundedData}
          now={now}
          remindersEnabled={false}
          onViewFullSchedule={() => undefined}
          onOpenReminderSettings={() => undefined}
        />,
      );
    });

    expect(container.textContent).toContain('至少 60 条 Moment');
    expect(container.textContent).not.toContain('reviews in the next 24 hours');
  });

  it('routes full schedule/reminder controls and returns focus safely on collapse', () => {
    const onViewFullSchedule = vi.fn();
    const onOpenReminderSettings = vi.fn();
    act(() => {
      root.render(
        <UpcomingReviewsCard
          data={data([item('future', new Date(2026, 6, 21, 19, 40))])}
          now={now}
          remindersEnabled={false}
          onViewFullSchedule={onViewFullSchedule}
          onOpenReminderSettings={onOpenReminderSettings}
        />,
      );
    });
    const toggle = button('显示即将到期')!;
    act(() => toggle.click());
    act(() => toggle.focus());
    act(() => button('收起')?.click());
    expect(document.activeElement).toBe(toggle);

    act(() => button('查看完整日程')?.click());
    act(() => button('开启提醒')?.click());
    expect(onViewFullSchedule).toHaveBeenCalledOnce();
    expect(onOpenReminderSettings).toHaveBeenCalledOnce();
  });

  it('shows no-item and due-only boundary states', () => {
    act(() => {
      root.render(
        <UpcomingReviewsCard
          data={{ ...data([]), dueCount: 4 }}
          now={now}
          remindersEnabled
          onViewFullSchedule={() => undefined}
          onOpenReminderSettings={() => undefined}
        />,
      );
    });
    expect(container.textContent).toContain('现在有 4 条复习可以开始');
    expect(container.textContent).toContain('之后没有已安排的复习');

    act(() =>
      root.render(
        <UpcomingReviewsCard
          data={data([])}
          now={now}
          remindersEnabled={false}
          onViewFullSchedule={() => undefined}
          onOpenReminderSettings={() => undefined}
        />,
      ),
    );
    expect(container.textContent).toContain('没有已安排的复习');
    expect(container.textContent).toContain('保存一条学习 Moment 即可开始');
  });

  it('maps all reminder status states without changing alarms', () => {
    expect(formatReminderStatus(false, null, now)).toBe('复习通知已关闭');
    expect(formatReminderStatus(true, null, now)).toBe('提醒状态未知');
    expect(
      formatReminderStatus(
        true,
        {
          ok: true,
          status: { nextReviewReminderAt: null, notificationPermission: 'denied' },
        },
        now,
      ),
    ).toBe('通知权限不可用');
    expect(
      formatReminderStatus(
        true,
        {
          ok: true,
          status: { nextReviewReminderAt: null, notificationPermission: 'granted' },
        },
        now,
      ),
    ).toBe('没有已安排的未来复习');
  });

  it('opens disclosure immediately under reduced motion without changing content limits', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        media: '(prefers-reduced-motion: reduce)',
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    act(() => {
      root.render(
        <UpcomingReviewsCard
          data={data([item('future', new Date(2026, 6, 21, 19, 40))])}
          now={now}
          remindersEnabled={false}
          onViewFullSchedule={() => undefined}
          onOpenReminderSettings={() => undefined}
        />,
      );
    });
    act(() => button('显示即将到期')?.click());
    expect(
      container.querySelector('.home-upcoming-disclosure')?.getAttribute('data-expanded'),
    ).toBe('true');
    expect(container.querySelectorAll('.upcoming-cohort')).toHaveLength(1);
  });

  function button(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === label,
    );
  }

  function itemControl(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll<HTMLButtonElement>('.upcoming-cohort-items button')].find(
      (candidate) => candidate.textContent === label,
    );
  }
});

function data(items: VideoLearningItem[]): HomeDashboardData {
  return {
    dueCount: 0,
    reviewsCompletedToday: 0,
    recentCaptures: [],
    upcoming: { items, nextCursor: null, hasMore: false, invalidCount: 0 },
    next24HourTotal: items.length,
  };
}

function item(id: string, due: Date): VideoLearningItem {
  const card = createEmptyCard(due);
  card.state = State.Review;
  return {
    id,
    schemaVersion: 2,
    platform: 'bilibili',
    sourceUrl: `https://www.bilibili.com/video/BV${id}`,
    canonicalUrl: null,
    videoId: id,
    videoTitle: `Lesson ${id}`,
    uploader: null,
    description: null,
    timestampSeconds: 42,
    timestampDisplay: '00:42',
    videoDurationSeconds: 180,
    chapterTitle: null,
    screenshotId: `screenshot-${id}`,
    subtitleBefore: [],
    subtitleCurrent: [],
    subtitleAfter: [],
    subtitleCueData: [],
    categoryId: null,
    itemType: 'Notice',
    personalNote: '',
    situation: '',
    coreLesson: '',
    mistakeToAvoid: '',
    recommendedAction: '',
    reason: '',
    recallPrompt: `Question ${id}`,
    referenceAnswer: `Private answer ${id}`,
    tags: [],
    createdAt: new Date(2026, 6, 20),
    updatedAt: new Date(2026, 6, 20),
    fsrsCard: card,
    reviewHistory: [],
    suspended: false,
    extractionDiagnostics: [],
  };
}
