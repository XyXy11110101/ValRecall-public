import { installDraftMemoryPort } from '../testing/draft-port';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { Rating, createEmptyCard, fsrs } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DailyTask, ReviewRecord, TaskDaySummary, VideoLearningItem } from '../database';
import {
  applyTaskCreationReward,
  DEFAULT_ALLOWANCE,
  TASK_CREATION_REWARD,
  TASK_REWARD,
} from '../shared/allowance';
import { HomeView, taskSummaryFromOverview } from './HomeView';
import { allDonePose, invitePose } from '../companion/companion-scenes';
import { companionArtPath, outfitForDate } from '../companion/wardrobe';
import { buildHomeTaskOverview } from '../models/task-overview';
import { requestEditorLeave, requestEditorLeaveAsync } from '../shared/edit-protection';
import { TASK_CELEBRATION_MS } from '../shared/task-celebration';
import { REFRESH_REVEAL_DELAY_MS } from '../shared/use-delayed-flag';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = new Date(2026, 6, 21, 12, 0, 0);

function item(
  id: string,
  overrides: Partial<Pick<VideoLearningItem, 'createdAt' | 'reviewHistory' | 'suspended'>> & {
    due?: Date;
  } = {},
): VideoLearningItem {
  const createdAt = overrides.createdAt ?? new Date(2026, 6, 20, 9);
  const due = overrides.due ?? now;
  return {
    id,
    schemaVersion: 2,
    platform: 'bilibili',
    sourceUrl: `https://www.bilibili.com/video/${id}`,
    canonicalUrl: null,
    videoId: id,
    videoTitle: `Lesson ${id}`,
    uploader: null,
    description: null,
    timestampSeconds: 42,
    timestampDisplay: '00:42',
    videoDurationSeconds: 180,
    chapterTitle: null,
    screenshotId: null,
    subtitleBefore: [],
    subtitleCurrent: [],
    subtitleAfter: [],
    subtitleCueData: [],
    categoryId: null,
    itemType: 'Notice',
    personalNote: '',
    situation: '',
    coreLesson: `Core ${id}`,
    mistakeToAvoid: '',
    recommendedAction: '',
    reason: '',
    recallPrompt: `Recall ${id}`,
    referenceAnswer: `Answer ${id}`,
    tags: [],
    createdAt,
    updatedAt: createdAt,
    fsrsCard: { ...createEmptyCard(due), due },
    reviewHistory: overrides.reviewHistory ?? [],
    suspended: overrides.suspended ?? false,
    extractionDiagnostics: [],
  };
}

function review(reviewedAt: Date): ReviewRecord {
  const result = fsrs().next(createEmptyCard(reviewedAt), reviewedAt, Rating.Good);
  return { id: 'review-1', itemId: 'due', reviewedAt, log: result.log };
}

function dailyTask(id: string, title: string): DailyTask {
  return {
    id,
    schemaVersion: 1,
    title,
    notes: null,
    kind: 'routine',
    recurrence: 'daily',
    scheduledDate: null,
    scheduledTime: null,
    selectedWeekdays: [],
    linkedLearningItemId: null,
    priority: 'normal',
    archived: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function emptyTasks(localDate: string): TaskDaySummary {
  return { localDate, total: 0, completed: 0, remaining: 0, occurrences: [] };
}

describe('HomeView', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    installDraftMemoryPort();
    vi.stubGlobal('chrome', {
      storage: {
        local: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) },
      },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('renders due, completed-today, recent, and upcoming summaries', () => {
    const markup = renderToStaticMarkup(
      <HomeView
        revision={0}
        onStartReview={() => undefined}
        onAddQuestion={() => undefined}
        clock={() => now}
        items={[
          item('due', { reviewHistory: [review(new Date(2026, 6, 21, 8))] }),
          item('upcoming', {
            createdAt: new Date(2026, 6, 21, 10),
            due: new Date(2026, 6, 22, 12),
          }),
        ]}
      />,
    );
    const rendered = new DOMParser().parseFromString(markup, 'text/html');
    const text = rendered.body.textContent ?? '';
    const homeLayout = rendered.querySelector('.home-layout');
    const companionStage = homeLayout?.querySelector('[data-home-region="companion"]');
    const contentRegion = homeLayout?.querySelector('[data-home-region="content"]');
    const companions = rendered.querySelectorAll('.companion');

    expect(text).toContain('1条到期');
    expect(text).toContain('1今天已复习');
    expect(text).toContain('零花钱');
    expect(text).toContain('连续天数');
    expect(rendered.querySelector('.home-streak-stat')).not.toBeNull();
    expect(rendered.querySelector('.home-allowance-balance')).not.toBeNull();
    expect(contentRegion?.contains(rendered.querySelector('.home-allowance-balance'))).toBe(true);
    expect(rendered.querySelector('.home-allowance-card')).toBeNull();
    expect(text).toContain('Lesson due');
    expect(text).toContain('Lesson upcoming');
    expect(homeLayout?.getAttribute('data-home-composition')).toBe('companion-first');
    expect(homeLayout?.firstElementChild).toBe(rendered.querySelector('.home-workspaces'));
    expect(rendered.querySelector('.home-learning-workspace')?.firstElementChild).toBe(
      rendered.querySelector('.home-today'),
    );
    expect(rendered.querySelector('.home-today')?.firstElementChild).toBe(companionStage);
    expect(companionStage?.nextElementSibling).toBe(contentRegion);
    expect(companionStage?.getAttribute('data-home-stage-state')).toBe('due');
    expect(companions).toHaveLength(1);
    expect(companions[0]?.getAttribute('data-companion-state')).toBe('due');
    expect(companions[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(
      companionStage?.querySelector(
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).toBeNull();
  });

  it('uses the idle companion when no unsuspended item is due', () => {
    const markup = renderToStaticMarkup(
      <HomeView
        revision={0}
        onStartReview={() => undefined}
        onAddQuestion={() => undefined}
        clock={() => now}
        items={[item('future', { due: new Date(2026, 6, 22) })]}
      />,
    );
    const rendered = new DOMParser().parseFromString(markup, 'text/html');

    expect(rendered.querySelector('.companion')?.getAttribute('data-companion-state')).toBe('idle');
    expect(
      rendered.querySelector('.home-companion-stage')?.getAttribute('data-home-stage-state'),
    ).toBe('idle');
  });

  it('rests in the peace sign once today is done, and stays calm when nothing was planned', async () => {
    const decode = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value: decode,
    });
    try {
      const task = dailyTask('task-done', 'Review setup notes');
      const doneToday: TaskDaySummary = {
        localDate: '2026-07-21',
        total: 1,
        completed: 1,
        remaining: 0,
        occurrences: [
          {
            task,
            localDate: '2026-07-21',
            completion: {
              id: 'completion-done',
              taskId: task.id,
              localDate: '2026-07-21',
              completedAt: now.toISOString(),
            },
          },
        ],
      };
      const view = (summary: TaskDaySummary) => (
        <HomeView
          revision={0}
          onStartReview={() => undefined}
          onAddQuestion={() => undefined}
          clock={() => now}
          items={[]}
          taskSummary={summary}
        />
      );
      await act(async () => root.render(view(doneToday)));
      await act(async () => Promise.resolve());

      const stage = () => container.querySelector('.home-companion-stage');
      const outfit = outfitForDate('2026-07-21');
      expect(stage()?.getAttribute('data-home-stage-state')).toBe('success');
      expect(stage()?.querySelector('img')?.getAttribute('src')).toBe(
        companionArtPath(outfit, allDonePose('2026-07-21'), 'animated'),
      );
      expect(stage()?.textContent).toContain('今天都跟上进度了。');

      // Nothing was planned at noon: the reading pose, in the same outfit.
      await act(async () => root.render(view(emptyTasks('2026-07-21'))));
      expect(stage()?.getAttribute('data-home-stage-state')).toBe('idle');
      expect(stage()?.querySelector('img')?.getAttribute('src')).toBe(
        companionArtPath(outfit, 'read', 'animated'),
      );
    } finally {
      delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
    }
  });

  it.each([
    [8, 'wave'],
    [14, 'read'],
    [19, 'tea'],
    [23, 'calm'],
  ] as const)('takes the idle pose for the hour (%s:00 → %s)', (hour, pose) => {
    const clock = new Date(2026, 9, 28, hour, 0);
    const markup = renderToStaticMarkup(
      <HomeView
        revision={0}
        onStartReview={() => undefined}
        onAddQuestion={() => undefined}
        clock={() => clock}
        items={[]}
        taskSummary={emptyTasks('2026-10-28')}
      />,
    );
    const companion = new DOMParser()
      .parseFromString(markup, 'text/html')
      .querySelector('.home-companion-stage .companion');
    expect(companion?.getAttribute('data-companion-state')).toBe('idle');
    expect(companion?.getAttribute('data-companion-pose')).toBe(pose);
    expect(companion?.querySelector('img')?.getAttribute('src')).toBe(
      companionArtPath(outfitForDate('2026-10-28'), pose, 'animated'),
    );
  });

  it('invites to due reviews, and cheers on todos when only todos are left', () => {
    const clock = new Date(2026, 9, 28, 14, 0);
    const pose = (items: VideoLearningItem[], summary: TaskDaySummary) =>
      new DOMParser()
        .parseFromString(
          renderToStaticMarkup(
            <HomeView
              revision={0}
              onStartReview={() => undefined}
              onAddQuestion={() => undefined}
              clock={() => clock}
              items={items}
              taskSummary={summary}
            />,
          ),
          'text/html',
        )
        .querySelector('.home-companion-stage .companion')
        ?.getAttribute('data-companion-pose');
    const task = dailyTask('task-open', 'Warm up');
    const openTasks: TaskDaySummary = {
      localDate: '2026-10-28',
      total: 1,
      completed: 0,
      remaining: 1,
      occurrences: [{ task, localDate: '2026-10-28', completion: null }],
    };
    const dueItem = item('due', { due: new Date(2026, 9, 28, 9) });

    expect(pose([dueItem], emptyTasks('2026-10-28'))).toBe(invitePose('2026-10-28'));
    expect(pose([dueItem], openTasks)).toBe(invitePose('2026-10-28'));
    expect(pose([], openTasks)).toBe('fist');
  });

  it('names the page for screen readers and focus only, and adds no lines of its own', () => {
    const markup = renderToStaticMarkup(
      <HomeView
        revision={0}
        onStartReview={() => undefined}
        onAddQuestion={() => undefined}
        clock={() => now}
        items={[item('due')]}
        taskSummary={emptyTasks('2026-07-21')}
      />,
    );
    const rendered = new DOMParser().parseFromString(markup, 'text/html');
    const heading = rendered.querySelector('#home-heading');
    expect(heading?.textContent).toBe('今天的学习');
    expect(heading?.classList.contains('sr-only')).toBe(true);
    expect(heading?.classList.contains('dashboard-page-heading')).toBe(true);
    expect(heading?.getAttribute('tabindex')).toBe('-1');
    expect(rendered.querySelector('.home-view')?.getAttribute('aria-labelledby')).toBe(
      'home-heading',
    );
    expect(rendered.querySelector('.home-edition')?.textContent).toBe('2026 / 07 / 21');
    const text = rendered.body.textContent ?? '';
    for (const words of [
      '每日回顾',
      '把下一步变成行动',
      '现在没有要复习的。',
      '今天的复习做完了。',
      '每复习一道 +1 元。',
      '没有逾期任务',
      '今天没有未完成的任务',
      '没有之后的安排',
      '今天还没有完成记录。',
      '复习预告',
    ])
      expect(text).not.toContain(words);
  });

  it('keeps the error sentences of the review summary', async () => {
    const loadItems = vi.fn().mockRejectedValueOnce(new Error('Summary unavailable'));
    await act(async () =>
      root.render(
        <HomeView
          revision={0}
          onStartReview={() => undefined}
          onAddQuestion={() => undefined}
          loadItems={loadItems}
          loadTaskSummary={async (localDate) => emptyTasks(localDate)}
          clock={() => now}
        />,
      ),
    );
    expect(container.querySelector('.home-summary-description')?.textContent).toBe('请重试。');
  });

  it('marks only first entry for the restrained hierarchy and keeps the Companion in Home', () => {
    const markup = renderToStaticMarkup(
      <HomeView
        initialEntry
        revision={0}
        onStartReview={() => undefined}
        onAddQuestion={() => undefined}
        clock={() => now}
        items={[item('due')]}
        taskSummary={emptyTasks('2026-07-21')}
      />,
    );
    const rendered = new DOMParser().parseFromString(markup, 'text/html');

    expect(rendered.querySelector('.home-view')?.getAttribute('data-initial-entry')).toBe('true');
    expect(rendered.querySelectorAll('.home-entry-region')).toHaveLength(4);
    expect(rendered.querySelector('.home-today')?.firstElementChild).toBe(
      rendered.querySelector('.home-companion-stage'),
    );
    expect(rendered.querySelector('.companion')?.getAttribute('data-companion-placement')).toBe(
      'home',
    );
  });

  it('offers only review and unified creation in the main study actions', async () => {
    const onStartReview = vi.fn();
    const onAddQuestion = vi.fn();
    await act(async () => {
      root.render(
        <HomeView
          revision={0}
          onStartReview={onStartReview}
          onAddQuestion={onAddQuestion}
          clock={() => now}
          items={[item('due')]}
        />,
      );
    });

    const buttons = [...container.querySelectorAll('button')];
    await act(async () => buttons.find((button) => button.textContent === '开始复习')?.click());
    await act(async () => buttons.find((button) => button.textContent === '添加回忆题')?.click());

    expect(onStartReview).toHaveBeenCalledOnce();
    expect(onAddQuestion).toHaveBeenCalledOnce();
    expect(
      [...container.querySelectorAll('.home-summary-primary button')].map(
        (button) => button.textContent,
      ),
    ).toEqual(['开始复习', '添加回忆题']);
    expect(textButton('打开资料库')).toBeUndefined();
    expect(textButton('选择复习范围')).toBeUndefined();
    expect(textButton('记录阅读')).toBeUndefined();
    expect(textButton('接收整理结果')).toBeUndefined();
  });

  it('offers one primary Add question action when no items are due', async () => {
    const onStartReview = vi.fn();
    const onAddQuestion = vi.fn();
    await act(async () => {
      root.render(
        <HomeView
          revision={0}
          items={[item('future', { due: new Date(2026, 6, 22, 12) })]}
          clock={() => now}
          onStartReview={onStartReview}
          onAddQuestion={onAddQuestion}
        />,
      );
    });

    expect(container.querySelector('.home-start-action')?.textContent).toBe('添加回忆题');
    expect(container.querySelectorAll('.home-summary-primary button')).toHaveLength(1);
    expect(textButton('添加回忆题')?.classList.contains('text-button')).toBe(false);
    expect(textButton('开始复习')).toBeUndefined();
    expect(container.querySelector('.home-summary-description')).toBeNull();
    expect(container.textContent).toContain('Lesson future');
    await act(async () => textButton('添加回忆题')?.click());
    expect(onAddQuestion).toHaveBeenCalledOnce();
    expect(onStartReview).not.toHaveBeenCalled();
  });

  it('keeps review primary when due items exist and adds without starting a session', async () => {
    const onStartReview = vi.fn();
    const onAddQuestion = vi.fn();
    await act(async () => {
      root.render(
        <HomeView
          revision={0}
          items={[item('due')]}
          clock={() => now}
          onStartReview={onStartReview}
          onAddQuestion={onAddQuestion}
        />,
      );
    });

    expect(container.querySelector('.home-start-action')?.textContent).toBe('开始复习');
    expect(textButton('添加回忆题')?.classList.contains('text-button')).toBe(true);
    await act(async () => textButton('添加回忆题')?.click());
    expect(onAddQuestion).toHaveBeenCalledOnce();
    expect(onStartReview).not.toHaveBeenCalled();
    await act(async () => textButton('开始复习')?.click());
    expect(onStartReview).toHaveBeenCalledOnce();
  });

  it('opens recent Moment details directly without starting review', async () => {
    const recent = item('recent');
    const onStartReview = vi.fn();
    const onViewItem = vi.fn();
    await act(async () =>
      root.render(
        <HomeView
          revision={0}
          items={[recent]}
          clock={() => now}
          onStartReview={onStartReview}
          onAddQuestion={() => undefined}
          onViewItem={onViewItem}
        />,
      ),
    );
    expect(container.querySelector('.home-recent-excerpt')?.textContent).toBe(recent.coreLesson);
    expect(container.querySelector('.home-recent-details')).toBeNull();
    expect(
      container
        .querySelector('.home-list-card')
        ?.compareDocumentPosition(container.querySelector('.home-statistics')!),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('.home-recent-copy .content-title-button')
        ?.click(),
    );
    expect(onViewItem).toHaveBeenCalledWith(recent);
    expect(onStartReview).not.toHaveBeenCalled();
  });

  it('shows streak and pocket-money amount on Home and opens the ledger page', async () => {
    const onOpenAllowance = vi.fn();
    await act(async () => {
      root.render(
        <HomeView
          revision={0}
          onStartReview={() => undefined}
          onAddQuestion={() => undefined}
          onOpenAllowance={onOpenAllowance}
          clock={() => now}
          items={[]}
          allowance={{ ...DEFAULT_ALLOWANCE, balance: 7, currentStreak: 4 }}
        />,
      );
    });
    expect(container.querySelector('.home-streak-stat')?.textContent).toContain('4');
    expect(container.querySelector('.home-streak-stat')?.textContent).toContain('连续天数');
    expect(container.querySelector('.home-allowance-balance')?.textContent).toContain('7');
    expect(container.querySelector('.home-allowance-balance')?.textContent).toContain('零花钱');
    expect(container.querySelector('.home-allowance-card')).toBeNull();
    expect(container.querySelector('.home-allowance-spend')).toBeNull();
    await act(async () =>
      (container.querySelector('.home-allowance-balance') as HTMLButtonElement | null)?.click(),
    );
    expect(onOpenAllowance).toHaveBeenCalledOnce();
  });

  it('loads items through the injected dependency', async () => {
    const loadItems = vi.fn().mockResolvedValue([item('loaded')]);

    await act(async () => {
      root.render(
        <HomeView
          revision={0}
          onStartReview={() => undefined}
          onAddQuestion={() => undefined}
          loadItems={loadItems}
          loadTaskSummary={async (localDate) => emptyTasks(localDate)}
          clock={() => now}
        />,
      );
      await Promise.resolve();
    });

    expect(loadItems).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Lesson loaded');
  });

  it('retains useful content during a refresh instead of replaying initial loading', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let resolveRefresh: ((items: VideoLearningItem[]) => void) | undefined;
    const loadItems = vi
      .fn()
      .mockResolvedValueOnce([item('existing')])
      .mockImplementationOnce(
        () =>
          new Promise<VideoLearningItem[]>((resolve) => {
            resolveRefresh = resolve;
          }),
      );
    const props = {
      onStartReview: () => undefined,
      onAddQuestion: () => undefined,
      loadItems,
      loadTaskSummary: async (localDate: string) => emptyTasks(localDate),
      clock: () => now,
    };

    await act(async () => {
      root.render(<HomeView {...props} revision={0} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Lesson existing');

    await act(async () => {
      root.render(<HomeView {...props} revision={1} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Lesson existing');
    // A refresh that ends quickly never flashes its status; a slow one is shown.
    expect(container.textContent).not.toContain('正在刷新今天的摘要');
    await act(async () => vi.advanceTimersByTime(REFRESH_REVEAL_DELAY_MS - 1));
    expect(container.textContent).not.toContain('正在刷新今天的摘要');
    await act(async () => vi.advanceTimersByTime(1));
    expect(container.textContent).toContain('正在刷新今天的摘要');
    expect(container.textContent).not.toContain('正在加载首页摘要');

    await act(async () => {
      resolveRefresh?.([item('replacement')]);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Lesson replacement');
    expect(container.textContent).not.toContain('正在刷新今天的摘要');
    vi.useRealTimers();
  });

  it('never flashes the refresh status for a quick refresh after a save', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const props = {
        onStartReview: () => undefined,
        onAddQuestion: () => undefined,
        loadItems: async () => [item('existing')],
        loadTaskSummary: async (localDate: string) => emptyTasks(localDate),
        clock: () => now,
      };
      await act(async () => root.render(<HomeView {...props} revision={0} />));
      const seen: string[] = [];
      const observer = new MutationObserver(() => {
        if (container.textContent?.includes('正在刷新今天的摘要')) seen.push('shown');
      });
      observer.observe(container, { childList: true, subtree: true, characterData: true });
      await act(async () => root.render(<HomeView {...props} revision={1} />));
      await act(async () => vi.advanceTimersByTime(REFRESH_REVEAL_DELAY_MS * 2));
      observer.disconnect();
      expect(seen).toEqual([]);
      expect(container.querySelector('.home-refresh-slot')?.childElementCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not show a companion when summary loading fails', async () => {
    const loadItems = vi.fn().mockRejectedValue(new Error('Database unavailable'));

    await act(async () => {
      root.render(
        <HomeView
          revision={0}
          onStartReview={() => undefined}
          onAddQuestion={() => undefined}
          loadItems={loadItems}
          loadTaskSummary={async (localDate) => emptyTasks(localDate)}
          clock={() => now}
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Database unavailable');
    expect(container.querySelector('.companion')).toBeNull();
    expect(container.querySelector('.home-companion-stage')).toBeNull();
    expect(container.querySelector('[data-home-region="content"]')).not.toBeNull();
  });

  it('shows unknown summary values after initial failure and explicitly retries', async () => {
    const loadItems = vi
      .fn()
      .mockRejectedValueOnce(new Error('Summary unavailable'))
      .mockResolvedValueOnce([item('recovered')]);
    const onStartReview = vi.fn();
    const onAddQuestion = vi.fn();
    const props = {
      revision: 0,
      onStartReview,
      onAddQuestion,
      loadItems,
      loadTaskSummary: async (localDate: string) => emptyTasks(localDate),
      clock: () => now,
    };
    await act(async () => root.render(<HomeView {...props} />));

    expect(container.textContent).toContain('摘要没加载出来');
    expect(container.querySelector('.home-due-count')).toBeNull();
    expect(container.querySelector('.home-completed-stat strong')?.textContent).toBe('—');
    expect(container.textContent).not.toContain('没有到期内容');
    expect(container.textContent).not.toContain('还没有保存过回忆题');
    expect(textButton('开始复习')).toBeUndefined();
    expect(container.querySelector('.home-start-action')?.textContent).toBe('重试首页摘要');
    expect(textButton('添加回忆题')?.classList.contains('text-button')).toBe(true);
    await act(async () => textButton('添加回忆题')?.click());
    expect(onAddQuestion).toHaveBeenCalledOnce();
    expect(loadItems).toHaveBeenCalledOnce();

    await act(async () => textButton('重试首页摘要')?.click());
    expect(loadItems).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('Summary unavailable');
    expect(container.textContent).toContain('Lesson recovered');
    expect(container.querySelector('.home-due-count strong')?.textContent).toBe('1');
    expect(textButton('开始复习')).toBeDefined();
    expect(onStartReview).not.toHaveBeenCalled();
    expect(onAddQuestion).toHaveBeenCalledOnce();
  });

  it('labels retained summary values after refresh failure and replaces them on retry', async () => {
    const loadItems = vi
      .fn()
      .mockResolvedValueOnce([item('existing')])
      .mockRejectedValueOnce(new Error('Refresh unavailable'))
      .mockResolvedValueOnce([item('future', { due: new Date(2026, 6, 22, 12) })]);
    const props = {
      onStartReview: vi.fn(),
      onAddQuestion: vi.fn(),
      loadItems,
      loadTaskSummary: async (localDate: string) => emptyTasks(localDate),
      clock: () => now,
    };
    await act(async () => root.render(<HomeView {...props} revision={0} />));
    await act(async () => root.render(<HomeView {...props} revision={1} />));

    expect(container.querySelector('.home-due-count strong')?.textContent).toBe('1');
    expect(container.textContent).toContain('Lesson existing');
    expect(textButton('重试首页摘要')).toBeDefined();
    expect(textButton('开始复习')).toBeDefined();

    await act(async () => textButton('重试首页摘要')?.click());
    expect(loadItems).toHaveBeenCalledTimes(3);
    expect(container.querySelector('.home-due-count strong')?.textContent).toBe('0');
    expect(container.textContent).toContain('Lesson future');
    expect(textButton('重试首页摘要')).toBeUndefined();
    expect(container.textContent).not.toContain('Refresh unavailable');
    expect(container.querySelector('.home-start-action')?.textContent).toBe('添加回忆题');
    expect(props.onStartReview).not.toHaveBeenCalled();
  });

  it('retries a failed refresh of an old zero-due summary without offering an empty session', async () => {
    const loadItems = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('Refresh unavailable'))
      .mockResolvedValueOnce([item('now-due')]);
    const props = {
      onStartReview: vi.fn(),
      onAddQuestion: vi.fn(),
      loadItems,
      loadTaskSummary: async (localDate: string) => emptyTasks(localDate),
      clock: () => now,
    };
    await act(async () => root.render(<HomeView {...props} revision={0} />));
    expect(container.querySelector('.home-start-action')?.textContent).toBe('添加回忆题');
    await act(async () => root.render(<HomeView {...props} revision={1} />));

    expect(container.textContent).toContain('摘要没更新，请重试。');
    expect(container.textContent).not.toContain('现在没有要复习的');
    expect(textButton('开始复习')).toBeUndefined();
    expect(
      [...container.querySelectorAll('.home-summary-primary button')].map(
        (button) => button.textContent,
      ),
    ).toEqual(['重试首页摘要', '添加回忆题']);
    expect(
      [...container.querySelectorAll('button')].filter(
        (button) => button.textContent === '重试首页摘要',
      ),
    ).toHaveLength(1);

    await act(async () => textButton('重试首页摘要')?.click());
    expect(container.querySelector('.home-due-count strong')?.textContent).toBe('1');
    expect(container.querySelector('.home-start-action')?.textContent).toBe('开始复习');
    expect(props.onStartReview).not.toHaveBeenCalled();
  });

  it('does not show the companion stage when today’s tasks fail to load', async () => {
    const loadTaskSummary = vi.fn().mockRejectedValue(new Error('Task summary unavailable'));

    await act(async () => {
      root.render(
        <HomeView
          revision={0}
          onStartReview={() => undefined}
          onAddQuestion={() => undefined}
          items={[]}
          loadTaskSummary={loadTaskSummary}
          clock={() => now}
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Task summary unavailable');
    expect(container.querySelector('.companion')).toBeNull();
    expect(container.querySelector('.home-companion-stage')).toBeNull();
    expect(container.querySelector('[data-home-region="content"]')).not.toBeNull();
  });

  it('shows separate task counts and routes completion, add, edit, and view-all actions', async () => {
    const first = dailyTask('task-1', 'Practise crosshair placement');
    const second = dailyTask('task-2', 'Review setup notes');
    const taskSummary: TaskDaySummary = {
      localDate: '2026-07-21',
      total: 2,
      completed: 1,
      remaining: 1,
      occurrences: [
        { task: first, localDate: '2026-07-21', completion: null },
        {
          task: second,
          localDate: '2026-07-21',
          completion: {
            id: 'completion-2',
            taskId: second.id,
            localDate: '2026-07-21',
            completedAt: now.toISOString(),
          },
        },
      ],
    };
    const complete = vi.fn().mockResolvedValue({
      created: true,
      completion: {
        id: 'completion-1',
        taskId: first.id,
        localDate: '2026-07-21',
        completedAt: now.toISOString(),
      },
    });
    const onOpenTasks = vi.fn();
    const onEditTask = vi.fn();

    await act(async () => {
      root.render(
        <HomeView
          revision={0}
          onStartReview={() => undefined}
          onAddQuestion={() => undefined}
          onOpenTasks={onOpenTasks}
          onEditTask={onEditTask}
          items={[]}
          taskSummary={taskSummary}
          taskActions={{
            complete,
            undo: vi.fn().mockResolvedValue(true),
            atomic: async (id, date) => {
              const saved = await complete(id, date);
              return {
                changed: saved.created,
                reward: {
                  state: { ...DEFAULT_ALLOWANCE, balance: TASK_REWARD, totalEarned: TASK_REWARD },
                  reward: TASK_REWARD,
                },
                warning: null,
              };
            },
          }}
          clock={() => now}
        />,
      );
    });

    expect(container.textContent).toContain('全部待办');
    // Today's plan counts what is due today plus what was already finished today.
    expect(container.querySelector('.home-task-progress')?.textContent).toBe('今天 1/2');
    expect(container.textContent).toContain('之后 0');

    await act(async () => {
      button('完成 Practise crosshair placement')?.click();
      await Promise.resolve();
    });
    expect(complete).toHaveBeenCalledWith('task-1', '2026-07-21');
    expect(container.querySelector('[data-allowance-stat="balance"]')?.textContent).toContain(
      String(TASK_REWARD),
    );
    // Finishing the last open item today is the all-done moment, announced once by the
    // hidden status line; no banner appears above the list.
    expect(liveStatus()).toEqual([`今天的待办都完成了，+${TASK_REWARD} 元零花钱。`]);
    expect(container.querySelector('.home-task-feedback .notice')).toBeNull();
    expect(container.querySelector('.notice.success')).toBeNull();
    const finished = container.querySelector('[data-task-id="task-1"]');
    expect(finished?.classList.contains('is-completing')).toBe(true);
    expect(finished?.querySelector('.home-task-check-mark')?.textContent).toBe('✓');
    expect(container.querySelector('.home-task-progress')?.classList).toContain('is-celebrating');

    await act(async () => textButton('添加待办')?.click());
    await act(async () => textButton('管理待办与历史')?.click());
    await act(async () => button('更多 Practise crosshair placement')?.click());
    await act(async () => button('编辑 Practise crosshair placement')?.click());
    expect(container.querySelector('.task-form')).not.toBeNull();
    expect(onOpenTasks).toHaveBeenCalledOnce();
    expect(onEditTask).toHaveBeenCalledWith(first);
  });

  it('lets the companion praise a committed completion briefly, and keeps undo plain', async () => {
    const first = dailyTask('task-1', 'Practise crosshair placement');
    const second = dailyTask('task-2', 'Review setup notes');
    const open = (task: DailyTask) => ({ task, localDate: '2026-07-21', completion: null });
    const taskSummary: TaskDaySummary = {
      localDate: '2026-07-21',
      total: 2,
      completed: 0,
      remaining: 2,
      occurrences: [open(first), open(second)],
    };
    const state = {
      ...DEFAULT_ALLOWANCE,
      balance: TASK_REWARD,
      ledgerSeq: 3,
      ledger: [
        {
          id: 'al-3',
          at: now.toISOString(),
          date: '2026-07-21',
          kind: 'earn' as const,
          source: 'task' as const,
          amount: TASK_REWARD,
          note: '完成今日计划',
          balanceAfter: TASK_REWARD,
        },
      ],
    };
    const atomic = vi.fn().mockResolvedValue({
      changed: true,
      reward: { state, reward: TASK_REWARD },
      warning: null,
    });
    const view = (summary: TaskDaySummary) => (
      <HomeView
        revision={0}
        onStartReview={() => undefined}
        onAddQuestion={() => undefined}
        items={[]}
        taskSummary={summary}
        taskActions={{ complete: vi.fn(), undo: vi.fn(), atomic }}
        clock={() => now}
      />
    );
    await act(async () => root.render(view(taskSummary)));
    const companionText = () => container.querySelector('.companion-copy')?.textContent ?? '';
    expect(companionText()).toBeDefined();

    vi.useFakeTimers();
    await act(async () => {
      button('完成 Practise crosshair placement')?.click();
      await Promise.resolve();
    });
    expect(companionText()).toMatch(/./u);
    expect(liveStatus()).toEqual([`已完成，+${TASK_REWARD} 元零花钱。`]);
    expect(container.querySelector('.notice')).toBeNull();
    await act(async () => vi.advanceTimersByTime(2400));
    expect(companionText()).not.toMatch(/你又|说到做到|划掉|行动力|离今天的目标/u);
    vi.useRealTimers();

    atomic.mockResolvedValueOnce({
      changed: true,
      reward: { state, reward: TASK_REWARD },
      warning: null,
    });
    const doneSummary: TaskDaySummary = {
      ...taskSummary,
      completed: 1,
      remaining: 1,
      occurrences: [
        {
          task: first,
          localDate: '2026-07-21',
          completion: {
            id: 'completion-1',
            taskId: first.id,
            localDate: '2026-07-21',
            completedAt: now.toISOString(),
          },
        },
        open(second),
      ],
    };
    await act(async () => root.render(view(doneSummary)));
    await act(async () => {
      button('撤销 Practise crosshair placement')?.click();
      await Promise.resolve();
    });
    expect(liveStatus()).toEqual([`已撤销完成，零花钱 −${TASK_REWARD} 元。`]);
    expect(container.querySelector('.notice')).toBeNull();
    expect(container.querySelector('.is-completing')).toBeNull();
  });

  it('cycles the reaction pose by today’s completions, fixed when the completion commits', async () => {
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });
    try {
      const done = dailyTask('task-done', 'Stretch');
      const first = dailyTask('task-1', 'Practise crosshair placement');
      const second = dailyTask('task-2', 'Review setup notes');
      const completion = (task: DailyTask) => ({
        id: `completion-${task.id}`,
        taskId: task.id,
        localDate: '2026-07-21',
        completedAt: now.toISOString(),
      });
      const summary = (completed: DailyTask[], open: DailyTask[]): TaskDaySummary => ({
        localDate: '2026-07-21',
        total: completed.length + open.length,
        completed: completed.length,
        remaining: open.length,
        occurrences: [
          ...completed.map((task) => ({
            task,
            localDate: '2026-07-21',
            completion: completion(task),
          })),
          ...open.map((task) => ({ task, localDate: '2026-07-21', completion: null })),
        ],
      });
      const state = {
        ...DEFAULT_ALLOWANCE,
        balance: TASK_REWARD,
        ledgerSeq: 4,
        ledger: [
          {
            id: 'al-4',
            at: now.toISOString(),
            date: '2026-07-21',
            kind: 'earn' as const,
            source: 'task' as const,
            amount: TASK_REWARD,
            note: '完成今日计划',
            balanceAfter: TASK_REWARD,
          },
        ],
      };
      const atomic = vi.fn().mockResolvedValue({
        changed: true,
        reward: { state, reward: TASK_REWARD },
        warning: null,
      });
      const view = (taskSummary: TaskDaySummary) => (
        <HomeView
          revision={0}
          onStartReview={() => undefined}
          onAddQuestion={() => undefined}
          items={[]}
          taskSummary={taskSummary}
          taskActions={{ complete: vi.fn(), undo: vi.fn(), atomic }}
          clock={() => now}
        />
      );
      const companion = () => container.querySelector('.home-companion-stage .companion');
      await act(async () => root.render(view(summary([done], [first, second]))));
      await act(async () => Promise.resolve());
      expect(companion()?.getAttribute('data-companion-pose')).toBe('fist');

      vi.useFakeTimers();
      await act(async () => {
        button('完成 Practise crosshair placement')?.click();
        await Promise.resolve();
      });
      // One completion already today, so this is the second reaction: clap.
      expect(companion()?.getAttribute('data-companion-state')).toBe('success');
      expect(companion()?.getAttribute('data-companion-pose')).toBe('clap');
      expect(companion()?.querySelector('img')?.getAttribute('src')).toBe(
        companionArtPath(outfitForDate('2026-07-21'), 'clap', 'animated'),
      );

      // The refreshed list arrives during the hold; the pose does not move.
      await act(async () => root.render(view(summary([done, first], [second]))));
      expect(companion()?.getAttribute('data-companion-pose')).toBe('clap');

      await act(async () => vi.advanceTimersByTime(2400));
      expect(companion()?.getAttribute('data-companion-state')).toBe('due');
      expect(companion()?.getAttribute('data-companion-pose')).toBe('fist');
    } finally {
      vi.useRealTimers();
      delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
    }
  });

  it('announces each result once in a hidden region and keeps warnings and errors visible', async () => {
    const rows = ['一', '二', '三', '四'].map((name, index) => dailyTask(`task-${index}`, name));
    const open = (task: DailyTask) => ({ task, localDate: '2026-07-21', completion: null });
    const summary: TaskDaySummary = {
      localDate: '2026-07-21',
      total: rows.length,
      completed: 0,
      remaining: rows.length,
      occurrences: rows.map(open),
    };
    const state = (seq: number) => ({
      ...DEFAULT_ALLOWANCE,
      balance: TASK_REWARD,
      ledgerSeq: seq,
      ledger: [
        {
          id: `al-${seq}`,
          at: now.toISOString(),
          date: '2026-07-21',
          kind: 'earn' as const,
          source: 'task' as const,
          amount: TASK_REWARD,
          note: '完成今日计划',
          balanceAfter: TASK_REWARD,
        },
      ],
    });
    const atomic = vi
      .fn()
      .mockResolvedValueOnce({
        changed: true,
        reward: { state: state(3), reward: 5 },
        warning: null,
      })
      .mockResolvedValueOnce({
        changed: true,
        reward: { state: state(4), reward: 5 },
        warning: null,
      })
      .mockResolvedValueOnce({
        changed: true,
        reward: null,
        warning: '奖励暂未确认，请稍后查看零花钱。',
      })
      .mockRejectedValueOnce(new Error('disk full'));
    await act(async () =>
      root.render(
        <HomeView
          revision={0}
          onStartReview={() => undefined}
          onAddQuestion={() => undefined}
          items={[]}
          taskSummary={summary}
          taskActions={{ complete: vi.fn(), undo: vi.fn(), atomic }}
          clock={() => now}
        />,
      ),
    );
    const region = () => container.querySelector('.home-task-feedback [role="status"]');
    // Always mounted and visually hidden, so it takes no space above the list.
    expect(region()?.classList.contains('sr-only')).toBe(true);
    expect(region()?.textContent).toBe('');
    expect(container.querySelector('.home-tasks-card > .home-task-feedback')).not.toBeNull();
    await act(async () => {
      button('完成 一')?.click();
      await Promise.resolve();
    });
    const spoken = region()?.firstElementChild;
    expect(spoken?.textContent).toBe(`已完成，+${TASK_REWARD} 元零花钱。`);
    expect(container.querySelectorAll('[role="status"].sr-only')).toHaveLength(1);
    await act(async () => {
      button('完成 二')?.click();
      await Promise.resolve();
    });
    // Identical words, a new node: a screen reader announces the second result too.
    const second2 = region()?.firstElementChild;
    expect(second2?.textContent).toBe(`已完成，+${TASK_REWARD} 元零花钱。`);
    expect(second2).not.toBe(spoken);

    await act(async () => {
      button('完成 三')?.click();
      await Promise.resolve();
    });
    const warning = container.querySelector('.home-task-feedback .notice.warning');
    expect(warning?.textContent).toBe('奖励暂未确认，请稍后查看零花钱。');
    expect(document.body.querySelector('.task-coin')).toBeNull();
    // The visible warning is the one announcement; the hidden line is not re-spoken.
    expect(region()?.firstElementChild).toBe(second2);

    await act(async () => {
      button('完成 四')?.click();
      await Promise.resolve();
    });
    expect(container.querySelector('.home-task-feedback .notice.warning')).toBeNull();
    expect(container.querySelector('.home-task-feedback .notice.error')?.textContent).toContain(
      '重新加载待办',
    );
  });

  it('updates counts and section state without replacing the full Home view', async () => {
    const homeProps = {
      revision: 0,
      onStartReview: () => undefined,
      onAddQuestion: () => undefined,
      clock: () => now,
    };
    await act(async () => {
      root.render(
        <HomeView
          {...homeProps}
          initialEntry
          items={[item('due')]}
          taskSummary={emptyTasks('2026-07-21')}
        />,
      );
    });
    const home = container.querySelector('.home-view');
    const headingRegion = container.querySelector('.home-entry-region');
    const companionStage = container.querySelector('.home-companion-stage');
    const contentRegion = container.querySelector('[data-home-region="content"]');
    expect(container.querySelector('.home-due-count .motion-count-change')?.textContent).toBe('1');

    const task = dailyTask('new-task', 'First task');
    await act(async () => {
      root.render(
        <HomeView
          {...homeProps}
          initialEntry={false}
          items={[]}
          taskSummary={{
            localDate: '2026-07-21',
            total: 1,
            completed: 0,
            remaining: 1,
            occurrences: [{ task, localDate: '2026-07-21', completion: null }],
          }}
        />,
      );
    });

    expect(container.querySelector('.home-view')).toBe(home);
    expect(container.querySelector('.home-entry-region')).toBe(headingRegion);
    expect(container.querySelector('.home-companion-stage')).toBe(companionStage);
    expect(container.querySelector('[data-home-region="content"]')).toBe(contentRegion);
    expect(container.querySelectorAll('.companion')).toHaveLength(1);
    expect(container.querySelector('.home-view')?.getAttribute('data-initial-entry')).toBe('false');
    expect(container.querySelector('.home-due-count .motion-count-change')?.textContent).toBe('0');
    expect(container.textContent).toContain('First task');
    expect(container.textContent).toContain('还没有保存过回忆题。');
    expect(container.querySelector('.home-section-state.motion-state-change')).not.toBeNull();
  });

  it('merges foreground notifications and keeps a failed refresh visible and retryable', async () => {
    vi.useFakeTimers();
    try {
      const existing = dailyTask('read-only', '保留可读任务');
      const load = vi
        .fn()
        .mockResolvedValue(
          taskSummaryFromOverview(buildHomeTaskOverview([existing], [], [], '2026-07-21')),
        );
      await act(async () =>
        root.render(
          <HomeView
            revision={0}
            items={[]}
            loadTaskSummary={load}
            clock={() => now}
            onStartReview={() => undefined}
            onAddQuestion={() => undefined}
          />,
        ),
      );
      expect(load).toHaveBeenCalledOnce();
      load.mockRejectedValueOnce(new Error('storage unavailable'));
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(load).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain('保留可读任务');
      expect(container.textContent).toContain('重新加载待办');
      await act(async () => textButton('重新加载待办')?.click());
      expect(load).toHaveBeenCalledTimes(3);
      expect(container.textContent).not.toContain('storage unavailable');
      await act(async () => vi.advanceTimersByTimeAsync(120_000));
      expect(load).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not settle yesterday recurring rows after midnight', async () => {
    let clockNow = now;
    const atomic = vi.fn();
    const row = dailyTask('old', '跨日重复任务');
    await act(async () =>
      root.render(
        <HomeView
          revision={0}
          items={[]}
          taskSummary={{
            localDate: '2026-07-21',
            total: 1,
            remaining: 1,
            completed: 0,
            occurrences: [{ task: row, localDate: '2026-07-21', completion: null }],
          }}
          taskActions={{ complete: vi.fn(), undo: vi.fn(), atomic }}
          clock={() => clockNow}
          onStartReview={() => undefined}
          onAddQuestion={() => undefined}
        />,
      ),
    );
    clockNow = new Date(2026, 6, 22, 0, 1);
    await act(async () => button('完成 跨日重复任务')?.click());
    expect(atomic).not.toHaveBeenCalled();
  });

  it('retries only the list after successful creation followed by a failed read', async () => {
    let saved: DailyTask | undefined;
    let failRead = false;
    const allowanceLoader = vi.fn(async () => ({ ...DEFAULT_ALLOWANCE, balance: saved ? 5 : 0 }));
    const load = vi.fn(async () => {
      if (failRead) throw new Error('read failed');
      return taskSummaryFromOverview(
        buildHomeTaskOverview(saved ? [saved] : [], [], [], '2026-07-21'),
      );
    });
    const createTask = vi.fn(async (input) => {
      saved = { ...dailyTask(input.id, input.title), ...input };
      failRead = true;
      return saved!;
    });
    await act(async () =>
      root.render(
        <HomeView
          revision={0}
          items={[]}
          loadTaskSummary={load}
          allowanceLoader={allowanceLoader}
          taskWriter={{ createTask }}
          clock={() => now}
          onStartReview={() => undefined}
          onAddQuestion={() => undefined}
        />,
      ),
    );
    await act(async () => textButton('添加待办')?.click());
    await act(async () => {
      const title = container.querySelector('input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        title,
        '只创建一次',
      );
      title.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => textButton('创建待办')?.click());
    expect(createTask).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('列表没刷新，请重新加载。');
    expect(container.querySelector('.home-allowance-balance')?.textContent).toContain('5');
    expect(container.querySelector('.task-form')).toBeNull();
    failRead = false;
    await act(async () => textButton('重新加载待办')?.click());
    expect(createTask).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('只创建一次');
    expect(document.activeElement?.getAttribute('data-task-id')).toBe(saved?.id);
  });

  describe('creation grant', () => {
    const today = '2026-07-21';
    const before = { ...DEFAULT_ALLOWANCE, balance: 7, totalEarned: 7 };
    const receipt = () => applyTaskCreationReward(before, today, now.toISOString());

    /** Places matching elements on screen; everything else has no box, as in jsdom. */
    function placeOnScreen(places: Record<string, [number, number]>) {
      return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: Element,
      ) {
        const entry = Object.entries(places).find(([selector]) => this.matches(selector));
        const [left, top] = entry?.[1] ?? [0, 0];
        const size = entry ? 20 : 0;
        return {
          left,
          top,
          x: left,
          y: top,
          width: size,
          height: size,
          right: left + size,
          bottom: top + size,
          toJSON: () => ({}),
        } as DOMRect;
      });
    }

    async function create(options: { failRead?: boolean; lostResponse?: boolean; title?: string }) {
      let saved: DailyTask | undefined;
      let readFails = false;
      const load = vi.fn(async () => {
        if (readFails) throw new Error('read failed');
        return taskSummaryFromOverview(buildHomeTaskOverview(saved ? [saved] : [], [], [], today));
      });
      // The first read is the page load; later reads never answer, so the balance shown after
      // the save can only come from the committed receipt.
      const allowanceLoader = vi
        .fn()
        .mockResolvedValueOnce(before)
        .mockImplementation(() => new Promise(() => undefined));
      const createTaskWithReward = vi.fn(async (input: DailyTask) => {
        saved = { ...dailyTask(input.id, input.title), ...input };
        readFails = options.failRead ?? false;
        if (options.lostResponse) throw new Error('response lost after commit');
        return { task: saved, reward: receipt() };
      });
      const writer = {
        createTask: vi.fn(),
        createTaskWithReward,
        getTask: vi.fn(async (id: string) => (saved?.id === id ? saved : undefined)),
      };
      await act(async () =>
        root.render(
          <HomeView
            revision={0}
            items={[]}
            loadTaskSummary={load}
            allowanceLoader={allowanceLoader}
            taskWriter={writer}
            clock={() => now}
            onStartReview={() => undefined}
            onAddQuestion={() => undefined}
          />,
        ),
      );
      await act(async () => textButton('添加待办')?.click());
      await act(async () => {
        const title = container.querySelector('input')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          title,
          options.title ?? '新建一件事',
        );
        title.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => textButton('创建待办')?.click());
      return { createTaskWithReward, saved: () => saved };
    }

    const coin = () => document.body.querySelector<HTMLElement>('.task-coin-layer .task-coin');
    const balance = () => container.querySelector('[data-allowance-stat="balance"]')?.textContent;

    it('flies the committed +5 from the new row to the wide wallet, once and without praise', async () => {
      const places = placeOnScreen({
        '[data-celebration-origin]': [300, 500],
        '[data-wallet-target="home"]': [700, 400],
        '[data-celebration-fallback]': [320, 150],
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const { saved } = await create({});
        expect(balance()).toContain(String(7 + TASK_CREATION_REWARD));
        expect(liveStatus()).toEqual([`待办已创建，+${TASK_CREATION_REWARD} 元零花钱。`]);
        expect(container.querySelector('.home-task-scroll .notice')).toBeNull();
        expect(container.querySelector('.notice')).toBeNull();
        const row = container.querySelector(`[data-task-id="${saved()?.id}"]`);
        expect(row?.querySelector('[data-celebration-origin]')).not.toBeNull();
        expect(coin()?.style.getPropertyValue('--coin-x')).toBe('310px');
        expect(coin()?.style.getPropertyValue('--coin-dx')).toBe('400px');
        expect(document.body.querySelector('.task-coin-tag')?.textContent).toBe(
          `+${TASK_CREATION_REWARD} 元`,
        );
        // A creation never stamps, folds or makes the companion praise anything.
        expect(container.querySelector('.is-completing, .home-task-ghost')).toBeNull();
        expect(container.querySelector('.home-task-progress.is-celebrating')).toBeNull();
        expect(container.querySelector('.companion-copy')?.textContent ?? '').not.toMatch(
          /你又|说到做到|划掉|行动力/u,
        );
        await act(async () => vi.advanceTimersByTime(1400));
        expect(coin()).toBeNull();
        // A later refresh of the same list never replays the grant.
        await act(async () => window.dispatchEvent(new Event('focus')));
        await act(async () => vi.advanceTimersByTime(200));
        expect(coin()).toBeNull();
      } finally {
        vi.useRealTimers();
        places.mockRestore();
      }
    });

    it('lands on the task card chip when the stacked Home hides the review wallet', async () => {
      const places = placeOnScreen({
        '[data-celebration-origin]': [100, 500],
        '[data-wallet-target="tasks-card"]': [200, 220],
      });
      try {
        await create({});
        expect(coin()?.style.getPropertyValue('--coin-dx')).toBe('100px');
        expect(coin()?.style.getPropertyValue('--coin-dy')).toBe('-280px');
      } finally {
        places.mockRestore();
      }
    });

    it('starts from the add button when the refreshed list cannot be read', async () => {
      const places = placeOnScreen({
        '[data-wallet-target="home"]': [700, 400],
        '[data-celebration-fallback]': [320, 150],
      });
      try {
        await create({ failRead: true });
        expect(container.textContent).toContain('列表没刷新，请重新加载。');
        expect(coin()?.style.getPropertyValue('--coin-x')).toBe('330px');
      } finally {
        places.mockRestore();
      }
    });

    it('shows no coin for an uncertain grant, under reduced motion only a static tag', async () => {
      const places = placeOnScreen({
        '[data-celebration-origin]': [300, 500],
        '[data-wallet-target="home"]': [700, 400],
      });
      try {
        await create({ lostResponse: true });
        expect(liveStatus()).toEqual(['待办已创建。']);
        expect(document.body.querySelector('.task-coin-layer')).toBeNull();
        await act(async () => root.unmount());
        root = createRoot(container);
        vi.stubGlobal('matchMedia', () => ({
          matches: true,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }));
        await create({ title: '安静模式' });
        expect(coin()).toBeNull();
        expect(document.body.querySelector('.task-coin-tag.is-static')?.textContent).toBe(
          `+${TASK_CREATION_REWARD} 元`,
        );
      } finally {
        vi.unstubAllGlobals();
        places.mockRestore();
      }
    });

    it('shows nothing while the page is hidden', async () => {
      const places = placeOnScreen({
        '[data-celebration-origin]': [300, 500],
        '[data-wallet-target="home"]': [700, 400],
      });
      const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      try {
        await create({});
        expect(liveStatus()).toEqual([`待办已创建，+${TASK_CREATION_REWARD} 元零花钱。`]);
        expect(document.body.querySelector('.task-coin-layer')).toBeNull();
      } finally {
        hidden.mockRestore();
        places.mockRestore();
      }
    });
  });

  function button(label: string): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  }

  /** What the hidden polite region currently says; it never draws a banner. */
  function liveStatus(): string[] {
    return [...container.querySelectorAll('.home-task-feedback [role="status"].sr-only')].map(
      (node) => node.textContent ?? '',
    );
  }

  function textButton(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find((entry) => entry.textContent === label);
  }

  describe('工作中 card', () => {
    const now = new Date(2026, 9, 30, 14);
    const today = '2026-10-30';
    afterEach(() => {
      delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });
    function stubCardStorage() {
      const values: Record<string, unknown> = {};
      vi.stubGlobal('chrome', {
        storage: {
          local: {
            get: vi.fn(async (key: string) => (key in values ? { [key]: values[key] } : {})),
            set: vi.fn(async (items: Record<string, unknown>) => void Object.assign(values, items)),
            remove: vi.fn(async () => undefined),
          },
        },
      });
      return values;
    }
    const stubDecode = () =>
      Object.defineProperty(HTMLImageElement.prototype, 'decode', {
        configurable: true,
        value: vi.fn().mockResolvedValue(undefined),
      });
    const open = dailyTask('open-one', 'Open one');
    const other = dailyTask('open-two', 'Open two');
    const overview = () =>
      taskSummaryFromOverview(buildHomeTaskOverview([open, other], [], [], today));
    const finished = () =>
      taskSummaryFromOverview(
        buildHomeTaskOverview(
          [open, other],
          [
            {
              id: 'done-1',
              taskId: open.id,
              localDate: today,
              completedAt: now.toISOString(),
            },
          ],
          [],
          today,
        ),
      );
    const companion = () => container.querySelector('.home-companion-stage .companion');
    const counts = () => container.querySelector('.home-task-counts')?.textContent;
    const layout = () => container.querySelector('.home-layout');
    const strip = () => container.querySelector<HTMLElement>('.home-review-strip');
    const working = () => layout()?.hasAttribute('data-working');
    const click = (label: string) =>
      act(async () => {
        const target = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
        if (!target) throw new Error(`Missing ${label}`);
        target.click();
      });
    const typeNotes = (value: string) =>
      act(() => {
        const el = container.querySelector<HTMLTextAreaElement>('#home-working-notes-input')!;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
          el,
          value,
        );
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    const notesValue = () =>
      container.querySelector<HTMLTextAreaElement>('#home-working-notes-input')?.value;
    const rewardReceipt = () => {
      const state = {
        ...DEFAULT_ALLOWANCE,
        balance: TASK_REWARD,
        ledgerSeq: 1,
        ledger: [
          {
            id: 'al-1',
            at: now.toISOString(),
            date: today,
            kind: 'earn' as const,
            source: 'task' as const,
            amount: TASK_REWARD,
            note: '完成今日计划',
            balanceAfter: TASK_REWARD,
          },
        ],
      };
      return { changed: true, reward: { state, reward: TASK_REWARD }, warning: null };
    };

    function view(extra: Record<string, unknown> = {}) {
      return (
        <HomeView
          revision={0}
          onStartReview={() => undefined}
          onAddQuestion={() => undefined}
          items={[]}
          taskSummary={overview()}
          clock={() => now}
          {...extra}
        />
      );
    }
    async function mount(extra: Record<string, unknown> = {}) {
      await act(async () => root.render(view(extra)));
      await act(async () => Promise.resolve());
    }

    it('turns Home into the working layout: review shrinks to a line, and the numbers stay', async () => {
      stubCardStorage();
      const onStartReview = vi.fn();
      const onOpenAllowance = vi.fn();
      await mount({
        items: [item('due', { due: new Date(2026, 9, 30, 9) })],
        allowance: { ...DEFAULT_ALLOWANCE, balance: 7, currentStreak: 4 },
        onStartReview,
        onOpenAllowance,
      });
      expect(working()).toBe(false);
      expect(strip()).toBeNull();
      const before = counts();

      await click('开始 Open one');
      expect(working()).toBe(true);
      expect(layout()?.firstElementChild).toBe(strip());
      expect(container.querySelector('.home-working-card')?.textContent).toContain('Open one');
      expect(counts()).toBe(before);
      expect(strip()?.getAttribute('aria-label')).toBeTruthy();
      expect(strip()?.querySelector('.home-review-strip-due')?.textContent).toBe('今日复习1条到期');
      expect(strip()?.textContent).toContain('连续 4 天');
      expect(strip()?.textContent).toContain('零花钱 7');
      expect(strip()?.querySelector('[data-wallet-target="home"]')?.textContent).toBe('7');

      // None of it is hidden with styles: it is simply not on the page.
      for (const selector of [
        '.home-learning-workspace',
        '.home-companion-stage',
        '.companion',
        '.home-recent-region',
        '.home-support-grid',
        '.home-statistics',
        '.home-upcoming-card',
      ])
        expect(container.querySelector(selector)).toBeNull();

      await act(async () =>
        [...strip()!.querySelectorAll('button')]
          .find((entry) => entry.textContent === '开始复习')
          ?.click(),
      );
      expect(onStartReview).toHaveBeenCalledOnce();
      await act(async () =>
        strip()!.querySelector<HTMLButtonElement>('[data-allowance-stat="balance"]')?.click(),
      );
      expect(onOpenAllowance).toHaveBeenCalledOnce();
    });

    it('offers 添加回忆题 in the strip when nothing is due', async () => {
      stubCardStorage();
      const onAddQuestion = vi.fn();
      await mount({ onAddQuestion });
      await click('开始 Open one');
      expect(strip()?.querySelector('.home-review-strip-due')?.textContent).toBe('今日复习0条到期');
      const action = strip()?.querySelector<HTMLButtonElement>('.home-review-strip-action');
      expect(action?.textContent).toBe('添加回忆题');
      await act(async () => action?.click());
      expect(onAddQuestion).toHaveBeenCalledOnce();
    });

    it('shows the still head in the strip, and no notes pose any more', async () => {
      stubCardStorage();
      await mount();
      await click('开始 Open one');
      const head = strip()?.querySelector('img');
      expect(head?.getAttribute('src')).toBe(
        companionArtPath(outfitForDate(today), 'head-smile', 'static'),
      );
      expect(head?.getAttribute('data-companion-motion')).toBe('static');
      expect(head?.getAttribute('aria-hidden')).toBe('true');
      await act(async () => textButton('先放下')?.click());
      expect(companion()?.getAttribute('data-companion-pose')).toBe('fist');
      expect(companion()?.querySelector('img')?.getAttribute('src')).toBe(
        companionArtPath(outfitForDate(today), 'fist', 'animated'),
      );
    });

    it('decodes the head before the first card and the resting pose before the figure comes back', async () => {
      stubCardStorage();
      const decoded: string[] = [];
      Object.defineProperty(HTMLImageElement.prototype, 'decode', {
        configurable: true,
        value(this: HTMLImageElement) {
          decoded.push(this.getAttribute('src') ?? '');
          return Promise.resolve();
        },
      });
      await mount();
      const outfit = outfitForDate(today);
      expect(decoded).toContain(companionArtPath(outfit, 'head-smile', 'static'));
      await click('开始 Open one');
      expect(decoded).toContain(companionArtPath(outfit, 'fist', 'animated'));
    });

    it('still reports a failed summary in the strip, with a retry and no face', async () => {
      stubCardStorage();
      const loadItems = vi
        .fn()
        .mockRejectedValueOnce(new Error('Summary unavailable'))
        .mockResolvedValue([item('recovered', { due: new Date(2026, 9, 30, 9) })]);
      await mount({ items: undefined, loadItems });
      await click('开始 Open one');
      expect(container.textContent).toContain('Summary unavailable');
      expect(strip()?.querySelector('.home-review-strip-due')?.textContent).toBe(
        '今日复习没加载出来',
      );
      expect(strip()?.querySelector('img')).toBeNull();
      const action = strip()?.querySelector<HTMLButtonElement>('.home-review-strip-action');
      expect(action?.textContent).toBe('重试首页摘要');
      await act(async () => action?.click());
      expect(loadItems).toHaveBeenCalledTimes(2);
      expect(strip()?.querySelector('.home-review-strip-due')?.textContent).toBe('今日复习1条到期');
      expect(strip()?.querySelector('.home-review-strip-action')?.textContent).toBe('开始复习');
    });

    describe('while the first summary read has failed', () => {
      const failing = () => vi.fn().mockRejectedValue(new Error('Summary unavailable'));
      const nextInput = () => container.querySelector<HTMLInputElement>('.home-working-next-input');
      const notes = () =>
        container.querySelector<HTMLTextAreaElement>('#home-working-notes-input')!;
      /** A minute passing, or the tab coming back: the two things that move the clock. */
      const tick = () =>
        act(async () => {
          document.dispatchEvent(new Event('visibilitychange'));
          await Promise.resolve();
        });

      it('keeps the page, the field and the caret through each tick of the clock', async () => {
        stubCardStorage();
        const loadItems = failing();
        await mount({ items: undefined, loadItems });
        expect(container.textContent).toContain('Summary unavailable');
        await click('开始 Open one');
        const field = notes();
        await act(async () => field.focus());
        await typeNotes('正在写的内容');

        await tick();
        expect(loadItems).toHaveBeenCalledTimes(2);
        expect(notes()).toBe(field);
        expect(document.activeElement).toBe(field);
        expect(field.value).toBe('正在写的内容');
        expect(container.querySelector('.home-loading-state')).toBeNull();
      });

      it('keeps an open next step, with its text, through each tick of the clock', async () => {
        stubCardStorage();
        await mount({ items: undefined, loadItems: failing() });
        await click('开始 Open one');
        await act(async () =>
          container.querySelector<HTMLButtonElement>('.home-working-next')!.click(),
        );
        const input = nextInput()!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
            input,
            '写小标题',
          );
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await tick();
        expect(nextInput()).toBe(input);
        expect(document.activeElement).toBe(input);
        expect(input.value).toBe('写小标题');
      });

      it('keeps the error on the page through a retry that fails the same way', async () => {
        stubCardStorage();
        const loadItems = failing();
        await mount({ items: undefined, loadItems });
        const notice = container.querySelector('.notice.error');
        expect(notice?.textContent).toBe('Summary unavailable');
        let cleared = false;
        const watcher = new MutationObserver(() => {
          if (!container.querySelector('.notice.error')) cleared = true;
        });
        watcher.observe(container, { subtree: true, childList: true });
        await tick();
        watcher.disconnect();
        expect(loadItems).toHaveBeenCalledTimes(2);
        expect(cleared).toBe(false);
        expect(container.querySelector('.notice.error')).toBe(notice);
      });

      it('shows the loading state for the first attempt only', async () => {
        stubCardStorage();
        let finish: (items: never[]) => void = () => undefined;
        const loadItems = vi
          .fn()
          .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
          .mockRejectedValueOnce(new Error('Summary unavailable'))
          .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
        await mount({ items: undefined, loadItems });
        expect(container.querySelector('.home-loading-state')).not.toBeNull();
        await act(async () => finish([]));
        expect(container.querySelector('.home-loading-state')).toBeNull();
        await tick();
        expect(container.textContent).toContain('Summary unavailable');
        await tick();
        expect(container.querySelector('.home-loading-state')).toBeNull();
        await act(async () => finish([]));
        expect(container.textContent).not.toContain('Summary unavailable');
      });
    });

    it('shows the loading state before the strip, and shows no face when tasks fail', async () => {
      const values = stubCardStorage();
      values['valrecall.workingCard'] = {
        version: 1,
        enabled: true,
        current: { taskId: open.id, startedOn: today },
        notes: [],
        trial: null,
      };
      let finishItems: (items: VideoLearningItem[]) => void = () => undefined;
      const summary = overview();
      const loadTaskSummary = vi
        .fn()
        .mockResolvedValueOnce(summary)
        .mockRejectedValue(new Error('Task summary unavailable'));
      await mount({
        items: undefined,
        taskSummary: undefined,
        loadItems: () => new Promise((resolve) => (finishItems = resolve)),
        loadTaskSummary,
      });
      expect(container.querySelector('.home-loading-state')).not.toBeNull();
      expect(strip()).toBeNull();
      await act(async () => finishItems([]));
      expect(strip()?.querySelector('img')).not.toBeNull();
      await act(async () => window.dispatchEvent(new Event('focus')));
      await act(async () => new Promise((done) => setTimeout(done, 120)));
      expect(container.textContent).toContain('Task summary unavailable');
      // The card and the strip stay, and every action on the card is blocked until a reload.
      expect(strip()?.querySelector('img')).toBeNull();
      expect(
        container.querySelector<HTMLButtonElement>('[aria-label="完成 Open one"]')?.disabled,
      ).toBe(true);
    });

    it('moves no money on start, put down or switch, and writes no task', async () => {
      const values = stubCardStorage();
      const atomic = vi.fn();
      const plan = { changeTaskSkipAtomic: vi.fn(), updateTask: vi.fn(), archiveTask: vi.fn() };
      await mount({
        taskActions: { complete: vi.fn(), undo: vi.fn(), atomic },
        taskPlanPort: plan,
      });
      await click('开始 Open one');
      await act(async () => textButton('先放下')?.click());
      await click('开始 Open two');
      expect(atomic).not.toHaveBeenCalled();
      expect(plan.updateTask).not.toHaveBeenCalled();
      expect(plan.archiveTask).not.toHaveBeenCalled();
      expect(plan.changeTaskSkipAtomic).not.toHaveBeenCalled();
      expect(values['valrecall.workingCard']).toMatchObject({
        current: { taskId: 'open-two', startedOn: today },
        trial: { startedOn: today, openOneOffsAtStart: 0, starts: 2 },
      });
    });

    describe('the flip between the layouts', () => {
      /** A browser that has taken the old picture only when the test says so. */
      function stubTransitions() {
        const flips: Array<{ commit: () => void }> = [];
        Object.assign(document, {
          startViewTransition: vi.fn((commit: () => void) => {
            flips.push({ commit });
            return {
              ready: Promise.resolve(),
              updateCallbackDone: Promise.resolve(),
              finished: Promise.resolve(),
              skipTransition: vi.fn(),
            };
          }),
        });
        return flips;
      }
      afterEach(() => {
        Reflect.deleteProperty(document, 'startViewTransition');
      });

      it('shows the true old page until the browser calls back, then lands focus on the check', async () => {
        stubCardStorage();
        const flips = stubTransitions();
        await mount();
        await click('开始 Open one');
        expect(flips).toHaveLength(1);
        // Nothing has moved: the row is still in the list and there is no card or strip.
        expect(working()).toBe(false);
        expect(strip()).toBeNull();
        expect(container.querySelector('.home-working-card')).toBeNull();
        expect(container.querySelector('[data-occurrence^="today:open-one"]')).not.toBeNull();
        expect(companion()).not.toBeNull();

        await act(async () => flips[0]!.commit());
        expect(working()).toBe(true);
        expect(strip()).not.toBeNull();
        expect(container.querySelector('[data-occurrence^="today:open-one"]')).toBeNull();
        expect(document.activeElement?.getAttribute('aria-label')).toBe('完成 Open one');
      });

      it('holds 先放下 the same way, and focus returns to the row', async () => {
        stubCardStorage();
        const flips = stubTransitions();
        await mount();
        await click('开始 Open one');
        await act(async () => flips[0]!.commit());
        await click('先放下 Open one');
        expect(flips).toHaveLength(2);
        expect(working()).toBe(true);
        expect(
          container.querySelector('.home-working-card [data-task-id="open-one"]'),
        ).not.toBeNull();
        await act(async () => flips[1]!.commit());
        expect(working()).toBe(false);
        expect(container.querySelector('.home-working-card')).toBeNull();
        expect(document.activeElement?.getAttribute('data-task-id')).toBe('open-one');
      });

      it('leaves no emptied card in the old picture when the moment ends, and the reaction starts at the switch', async () => {
        stubCardStorage();
        stubDecode();
        const flips = stubTransitions();
        const atomic = vi.fn().mockResolvedValue(rewardReceipt());
        const taskActions = { complete: vi.fn(), undo: vi.fn(), atomic };
        await mount({ taskActions });
        await click('开始 Open one');
        await act(async () => flips[0]!.commit());
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await click('完成 Open one');
        await act(async () => root.render(view({ taskActions, taskSummary: finished() })));
        await act(async () => vi.advanceTimersByTime(TASK_CELEBRATION_MS.total));

        // The stamp's time is up and the page is waiting for its picture: the card is still whole.
        expect(flips).toHaveLength(2);
        expect(working()).toBe(true);
        const ghost = container.querySelector('.home-working-card .home-task-ghost');
        expect(ghost).not.toBeNull();
        expect(ghost?.querySelector('.home-task-check-mark')?.textContent).toBe('✓');
        expect(container.querySelector('.home-working-fields')).not.toBeNull();
        expect(companion()).toBeNull();

        await act(async () => flips[1]!.commit());
        expect(working()).toBe(false);
        expect(container.querySelector('.home-task-ghost')).toBeNull();
        expect(companion()?.getAttribute('data-companion-pose')).toBe('cheer');

        // The full time, counted from the switch and not from the end of the stamp.
        await act(async () => vi.advanceTimersByTime(TASK_CELEBRATION_MS.companionHold - 1));
        expect(companion()?.getAttribute('data-companion-pose')).toBe('cheer');
        await act(async () => vi.advanceTimersByTime(1));
        expect(companion()?.getAttribute('data-companion-pose')).not.toBe('cheer');
      });

      describe('when a plan change on the card is taken back', () => {
        const skippedSummary = () =>
          taskSummaryFromOverview({
            ...buildHomeTaskOverview(
              [open, other],
              [],
              [{ taskId: open.id, date: today, skippedAt: now.toISOString() }],
              today,
            ),
            skipped: [{ task: open, localDate: today, completion: null }],
          });
        const port = () => ({
          changeTaskSkipAtomic: vi.fn().mockResolvedValue({ changed: true }),
          updateTask: vi.fn(),
          archiveTask: vi.fn(),
        });
        /** Starts Open one, skips it for today, and has the flip back behind it. */
        async function skippedCard(plan: ReturnType<typeof port>) {
          stubCardStorage();
          const flips = stubTransitions();
          await mount({ taskPlanPort: plan });
          await click('开始 Open one');
          await act(async () => flips[0]!.commit());
          await click('更多 Open one');
          await click('今天不做 Open one');
          await act(async () =>
            root.render(view({ taskPlanPort: plan, taskSummary: skippedSummary() })),
          );
          await act(async () => flips[1]!.commit());
          expect(working()).toBe(false);
          return flips;
        }
        const focused = () => document.activeElement?.getAttribute('data-occurrence');

        it('waits for the commit, and focus lands on the card and not a row it is about to lose', async () => {
          const plan = port();
          const flips = await skippedCard(plan);
          await click('撤销 Open one');
          await act(async () => root.render(view({ taskPlanPort: plan, taskSummary: overview() })));
          expect(flips).toHaveLength(3);
          expect(working()).toBe(false);
          expect(document.activeElement).not.toBe(
            container.querySelector('[data-occurrence^="today:open-one"]'),
          );
          await act(async () => flips[2]!.commit());
          expect(working()).toBe(true);
          expect(focused()).toBe(`working:open-one:${today}`);
        });

        it('does the same for 恢复今天', async () => {
          const plan = port();
          const flips = await skippedCard(plan);
          await click('恢复今天 Open one');
          await act(async () => root.render(view({ taskPlanPort: plan, taskSummary: overview() })));
          expect(flips).toHaveLength(3);
          await act(async () => flips[2]!.commit());
          expect(focused()).toBe(`working:open-one:${today}`);
        });
      });

      describe("a second completion during the card's moment", () => {
        const summaryOf = (...finishedTasks: DailyTask[]) =>
          taskSummaryFromOverview(
            buildHomeTaskOverview(
              [open, other],
              finishedTasks.map((task) => ({
                id: `done-${task.id}`,
                taskId: task.id,
                localDate: today,
                completedAt: now.toISOString(),
              })),
              [],
              today,
            ),
          );
        const secondReceipt = () => {
          const receipt = rewardReceipt();
          const state = {
            ...receipt.reward.state,
            ledgerSeq: 2,
            ledger: [{ ...receipt.reward.state.ledger[0]!, id: 'al-2' }],
          };
          return { ...receipt, reward: { state, reward: TASK_REWARD } };
        };

        async function secondCompletion() {
          stubCardStorage();
          stubDecode();
          const flips = stubTransitions();
          const atomic = vi
            .fn()
            .mockResolvedValueOnce(rewardReceipt())
            .mockResolvedValueOnce(secondReceipt());
          const taskActions = { complete: vi.fn(), undo: vi.fn(), atomic };
          await mount({ taskActions });
          await click('开始 Open one');
          await act(async () => flips[0]!.commit());
          vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
          await click('完成 Open one');
          await act(async () => root.render(view({ taskActions, taskSummary: summaryOf(open) })));
          expect(working()).toBe(true);
          return { flips, taskActions };
        }

        it('measures its coin on the page it flies over, not on the one leaving', async () => {
          const walletsMeasured: boolean[] = [];
          const { flips } = await secondCompletion();
          vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
            this: Element,
          ) {
            if (this.matches('[data-wallet-target]'))
              walletsMeasured.push(this.closest('.home-review-strip') !== null);
            return { left: 10, right: 40, top: 10, bottom: 40, width: 30, height: 30 } as DOMRect;
          });
          await click('完成 Open two');
          expect(flips).toHaveLength(2);
          expect(working()).toBe(true);
          expect(walletsMeasured).toEqual([]);

          await act(async () => flips[1]!.commit());
          expect(working()).toBe(false);
          expect(walletsMeasured.length).toBeGreaterThan(0);
          expect(walletsMeasured).not.toContain(true);
        });

        it('lets the newer reaction end the moment, with no older pose after it', async () => {
          const { flips } = await secondCompletion();
          await click('完成 Open two');
          await act(async () => vi.advanceTimersByTime(100));
          await act(async () => flips[1]!.commit());
          // One completion was already there when this one committed: the second reaction.
          expect(companion()?.getAttribute('data-companion-pose')).toBe('clap');

          await act(async () => vi.advanceTimersByTime(TASK_CELEBRATION_MS.companionHold - 100));
          const pose = companion()?.getAttribute('data-companion-pose');
          expect(pose).not.toBe('clap');
          expect(pose).not.toBe('cheer');
        });
      });

      it('stays on the card when the moment is undone, with no flip out and back', async () => {
        stubCardStorage();
        stubDecode();
        const flips = stubTransitions();
        const atomic = vi.fn().mockResolvedValue(rewardReceipt());
        const taskActions = { complete: vi.fn(), undo: vi.fn(), atomic };
        await mount({ taskActions });
        await click('开始 Open one');
        await act(async () => flips[0]!.commit());
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await click('完成 Open one');
        await act(async () => root.render(view({ taskActions, taskSummary: finished() })));
        expect(container.querySelector('.home-working-card .home-task-ghost')).not.toBeNull();

        await click('撤销 Open one');
        // Saved, and the list has not been read yet: the card is already whole again.
        expect(flips).toHaveLength(1);
        expect(working()).toBe(true);
        const row = () => container.querySelector('.home-working-card [data-task-id="open-one"]');
        expect(row()).not.toBeNull();
        expect(row()?.classList).not.toContain('is-completing');
        expect(row()?.querySelector('[aria-label="完成 Open one"]')).not.toBeNull();
        expect(container.querySelector('.home-task-ghost')).toBeNull();

        await act(async () => root.render(view({ taskActions })));
        await act(async () => vi.advanceTimersByTime(TASK_CELEBRATION_MS.total));
        expect(flips).toHaveLength(1);
        expect(working()).toBe(true);
        expect(row()).not.toBeNull();
      });

      it('goes back after an undo when the read shows the card is really gone', async () => {
        stubCardStorage();
        stubDecode();
        const flips = stubTransitions();
        const atomic = vi.fn().mockResolvedValue(rewardReceipt());
        const taskActions = { complete: vi.fn(), undo: vi.fn(), atomic };
        await mount({ taskActions });
        await click('开始 Open one');
        await act(async () => flips[0]!.commit());
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await click('完成 Open one');
        const read = finished();
        await act(async () => root.render(view({ taskActions, taskSummary: read })));
        await click('撤销 Open one');
        expect(working()).toBe(true);

        // A read that still has it finished, as after a failure or another device's change.
        await act(async () => root.render(view({ taskActions, taskSummary: finished() })));
        expect(flips).toHaveLength(2);
        await act(async () => flips[1]!.commit());
        expect(working()).toBe(false);
      });

      it('does not animate a page that opens with a card already on', async () => {
        const values = stubCardStorage();
        values['valrecall.workingCard'] = {
          version: 1,
          enabled: true,
          current: { taskId: 'open-one', startedOn: today },
          notes: [],
          trial: null,
        };
        const flips = stubTransitions();
        await mount();
        expect(working()).toBe(true);
        expect(flips).toHaveLength(0);
      });
    });

    it('stamps on the card, keeps the page still, then changes back once for the reaction', async () => {
      stubCardStorage();
      stubDecode();
      const atomic = vi.fn().mockResolvedValue(rewardReceipt());
      const taskActions = { complete: vi.fn(), undo: vi.fn(), atomic };
      await mount({ taskActions });
      await click('开始 Open one');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await click('完成 Open one');
      expect(atomic).toHaveBeenCalledExactlyOnceWith('open-one', today, true, now);
      expect(liveStatus()).toEqual([`已完成，+${TASK_REWARD} 元零花钱。`]);
      expect(strip()?.querySelector('[data-wallet-target="home"]')?.textContent).toBe(
        String(TASK_REWARD),
      );

      // The stamp plays where the click was: no figure yet, and nothing has moved.
      expect(working()).toBe(true);
      expect(companion()).toBeNull();
      expect(
        container.querySelector('.home-working-card [data-task-id="open-one"]')?.classList,
      ).toContain('is-completing');

      // The list refresh arrives during the stamp, and still nothing moves.
      await act(async () => root.render(view({ taskActions, taskSummary: finished() })));
      expect(working()).toBe(true);
      expect(container.querySelector('.home-working-card .home-task-ghost')).not.toBeNull();
      expect(container.querySelector('.home-task-progress')?.textContent).toBe('今天 1/2');
      await act(async () => vi.advanceTimersByTime(TASK_CELEBRATION_MS.total - 1));
      expect(working()).toBe(true);
      expect(container.querySelector('.home-working-card')).not.toBeNull();
      expect(companion()).toBeNull();

      // One step: the card, the strip and the working layout leave together, and the figure arrives.
      await act(async () => vi.advanceTimersByTime(1));
      expect(working()).toBe(false);
      expect(strip()).toBeNull();
      expect(container.querySelector('.home-working-card')).toBeNull();
      expect(container.querySelector('.home-task-ghost')).toBeNull();
      expect(companion()?.getAttribute('data-companion-pose')).toBe('cheer');
      expect(companion()?.querySelector('img')?.getAttribute('src')).toBe(
        companionArtPath(outfitForDate(today), 'cheer', 'animated'),
      );
      expect(container.querySelector('.companion-copy')?.textContent).toMatch(/./u);

      // The reaction gets its whole time on the page, not what the stamp left of it.
      await act(async () => vi.advanceTimersByTime(TASK_CELEBRATION_MS.companionHold - 1));
      expect(companion()?.getAttribute('data-companion-pose')).toBe('cheer');
      await act(async () => vi.advanceTimersByTime(1));
      expect(companion()?.getAttribute('data-companion-pose')).not.toBe('cheer');
      expect(atomic).toHaveBeenCalledOnce();
    });

    it('flies the coin from the card to the wallet in the strip', async () => {
      stubCardStorage();
      const places = vi
        .spyOn(Element.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: Element) {
          const place: Array<[string, number, number]> = [
            ['[data-celebration-key]', 100, 300],
            ['[data-wallet-target="home"]', 900, 40],
          ];
          const found = place.find(([selector]) => this.matches(selector));
          const [left, top, size] = found ? [found[1], found[2], 20] : [0, 0, 0];
          return {
            left,
            top,
            x: left,
            y: top,
            width: size,
            height: size,
            right: left + size,
            bottom: top + size,
            toJSON: () => ({}),
          } as DOMRect;
        });
      try {
        const atomic = vi.fn().mockResolvedValue(rewardReceipt());
        await mount({ taskActions: { complete: vi.fn(), undo: vi.fn(), atomic } });
        await click('开始 Open one');
        await click('完成 Open one');
        const coin = document.body.querySelector<HTMLElement>('.task-coin-layer .task-coin');
        expect(coin?.style.getPropertyValue('--coin-x')).toBe('110px');
        expect(coin?.style.getPropertyValue('--coin-dx')).toBe('800px');
        expect(coin?.style.getPropertyValue('--coin-dy')).toBe('-260px');
      } finally {
        places.mockRestore();
      }
    });

    it('changes back at once under reduced motion, with nothing held', async () => {
      stubCardStorage();
      stubDecode();
      vi.stubGlobal('matchMedia', () => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
      const atomic = vi.fn().mockResolvedValue(rewardReceipt());
      const taskActions = { complete: vi.fn(), undo: vi.fn(), atomic };
      await mount({ taskActions });
      await click('开始 Open one');
      await click('完成 Open one');
      await act(async () => root.render(view({ taskActions, taskSummary: finished() })));
      expect(working()).toBe(false);
      expect(container.querySelector('.home-working-card')).toBeNull();
      expect(companion()?.getAttribute('data-companion-pose')).toBe('cheer');
      expect(companion()?.querySelector('img')?.getAttribute('src')).toBe(
        companionArtPath(outfitForDate(today), 'cheer', 'static'),
      );
    });

    it('ends the moment with no reaction when the completion is undone during it', async () => {
      stubCardStorage();
      stubDecode();
      const atomic = vi.fn().mockResolvedValue(rewardReceipt());
      const taskActions = { complete: vi.fn(), undo: vi.fn(), atomic };
      await mount({ taskActions });
      await click('开始 Open one');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await click('完成 Open one');
      await act(async () => root.render(view({ taskActions, taskSummary: finished() })));
      await click('撤销 Open one');
      await act(async () => vi.advanceTimersByTime(TASK_CELEBRATION_MS.total));
      expect(atomic).toHaveBeenCalledTimes(2);
      expect(companion()?.getAttribute('data-companion-pose')).not.toBe('cheer');
      await act(async () => root.render(view({ taskActions })));
      // The card is still the current one, so it comes straight back.
      expect(working()).toBe(true);
      expect(
        container.querySelector('.home-working-card [data-task-id="open-one"]')?.classList,
      ).not.toContain('is-completing');
    });

    it('keeps the moment when a different row is undone during it', async () => {
      stubCardStorage();
      stubDecode();
      const atomic = vi.fn().mockResolvedValue(rewardReceipt());
      const taskActions = { complete: vi.fn(), undo: vi.fn(), atomic };
      const done = (task: DailyTask) => ({
        id: `done-${task.id}`,
        taskId: task.id,
        localDate: today,
        completedAt: now.toISOString(),
      });
      const summary = (...finishedTasks: DailyTask[]) =>
        taskSummaryFromOverview(
          buildHomeTaskOverview([open, other], finishedTasks.map(done), [], today),
        );
      await mount({ taskActions, taskSummary: summary(other) });
      await click('开始 Open one');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await click('完成 Open one');
      await act(async () => root.render(view({ taskActions, taskSummary: summary(open, other) })));
      expect(working()).toBe(true);
      await click('撤销 Open two');
      expect(atomic).toHaveBeenCalledTimes(2);
      expect(working()).toBe(true);
      expect(container.querySelector('.home-working-card .home-task-ghost')).not.toBeNull();
      await act(async () => vi.advanceTimersByTime(TASK_CELEBRATION_MS.total));
      expect(working()).toBe(false);
      // One completion was already there when this one committed: the second reaction.
      expect(companion()?.getAttribute('data-companion-pose')).toBe('clap');
    });

    it('goes back to the normal layout at once when the card is put down or skipped', async () => {
      stubCardStorage();
      const plan = {
        changeTaskSkipAtomic: vi.fn().mockResolvedValue({ changed: true }),
        updateTask: vi.fn(),
        archiveTask: vi.fn(),
      };
      const skipped = taskSummaryFromOverview(
        buildHomeTaskOverview(
          [open, other],
          [],
          [{ taskId: open.id, date: today, skippedAt: now.toISOString() }],
          today,
        ),
      );
      await mount({ taskPlanPort: plan });
      await click('开始 Open one');
      await act(async () => textButton('先放下')?.click());
      expect(working()).toBe(false);
      expect(companion()).not.toBeNull();
      await click('开始 Open one');
      expect(working()).toBe(true);
      await click('更多 Open one');
      await click('今天不做 Open one');
      await act(async () => root.render(view({ taskPlanPort: plan, taskSummary: skipped })));
      expect(working()).toBe(false);
      // The undo line stays in the card slot, in the normal layout.
      expect(container.querySelector('.home-working-card .home-task-undo')).not.toBeNull();
      expect(container.querySelector('.home-working-fields')).toBeNull();
    });

    describe('note', () => {
      const savedAt = new Date(2026, 9, 30, 14, 1).toISOString();
      const saved = { ...open, notes: '第三节先写结论', updatedAt: savedAt };
      const port = () => ({
        changeTaskSkipAtomic: vi.fn(),
        updateTask: vi.fn().mockResolvedValue(saved),
        archiveTask: vi.fn(),
      });

      it('saves to the task with no lock, no refresh and no reward, and nothing flashes', async () => {
        stubCardStorage();
        const plan = port();
        const atomic = vi.fn();
        const loadTaskSummary = vi.fn(async () => overview());
        const onTasksChanged = vi.fn();
        const allowanceLoader = vi.fn(async () => ({ ...DEFAULT_ALLOWANCE, balance: 7 }));
        await mount({
          taskSummary: undefined,
          loadTaskSummary,
          taskPlanPort: plan,
          taskActions: { complete: vi.fn(), undo: vi.fn(), atomic },
          onTasksChanged,
          allowanceLoader,
        });
        const allowanceReads = allowanceLoader.mock.calls.length;
        await click('开始 Open one');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await typeNotes('第三节先写结论');
        const busy: Array<string | null> = [];
        const home = container.querySelector('.home-view')!;
        const watcher = new MutationObserver(() => busy.push(home.getAttribute('aria-busy')));
        watcher.observe(home, { attributes: true, attributeFilter: ['aria-busy'] });
        await act(async () => vi.advanceTimersByTime(2000));
        watcher.disconnect();
        expect(plan.updateTask).toHaveBeenCalledExactlyOnceWith('open-one', {
          notes: '第三节先写结论',
        });
        expect(container.querySelector('.home-working-notes-status')?.textContent).toBe('已保存');
        expect(busy).toEqual([]);
        expect(loadTaskSummary).toHaveBeenCalledOnce();
        expect(allowanceLoader).toHaveBeenCalledTimes(allowanceReads);
        expect(onTasksChanged).not.toHaveBeenCalled();
        expect(atomic).not.toHaveBeenCalled();
        expect(
          container.querySelector<HTMLButtonElement>('[aria-label="完成 Open one"]')?.disabled,
        ).toBe(false);
      });

      it('hands the edit form the task as it is stored now', async () => {
        stubCardStorage();
        const plan = port();
        const onEditTask = vi.fn();
        await mount({
          taskSummary: undefined,
          loadTaskSummary: async () => overview(),
          taskPlanPort: plan,
          onEditTask,
        });
        await click('开始 Open one');
        await typeNotes('第三节先写结论');
        await click('更多 Open one');
        await click('编辑 Open one');
        expect(onEditTask).toHaveBeenCalledExactlyOnceWith(saved);
        // The row itself took the new version too, so a later edit does as well.
        await click('更多 Open one');
        await click('编辑 Open one');
        expect(onEditTask).toHaveBeenLastCalledWith(saved);
        expect(plan.updateTask).toHaveBeenCalledOnce();
      });

      it('does not let a read that began before the save put the old note back', async () => {
        stubCardStorage();
        const plan = port();
        const onEditTask = vi.fn();
        let answerRead: (summary: ReturnType<typeof overview>) => void = () => undefined;
        const loadTaskSummary = vi
          .fn()
          .mockResolvedValueOnce(overview())
          .mockImplementationOnce(() => new Promise((resolve) => (answerRead = resolve)));
        await mount({ taskSummary: undefined, loadTaskSummary, taskPlanPort: plan, onEditTask });
        await click('开始 Open one');
        await act(async () => window.dispatchEvent(new Event('focus')));
        await act(async () => new Promise((done) => setTimeout(done, 120)));
        expect(loadTaskSummary).toHaveBeenCalledTimes(2);
        await typeNotes('第三节先写结论');
        // The list is still refreshing, so the actions are not available: leaving the field saves.
        await act(async () =>
          container
            .querySelector('#home-working-notes-input')!
            .dispatchEvent(new FocusEvent('focusout', { bubbles: true })),
        );
        expect(plan.updateTask).toHaveBeenCalledOnce();
        await act(async () => answerRead(overview()));
        expect(notesValue()).toBe('第三节先写结论');
        await act(async () => Promise.resolve());
        await click('更多 Open one');
        await click('编辑 Open one');
        // The row has finished refreshing, and it is still the saved version.
        expect(onEditTask).toHaveBeenLastCalledWith(saved);
      });

      it('leaves the money alone when completing right after typing', async () => {
        stubCardStorage();
        stubDecode();
        const plan = port();
        const atomic = vi.fn().mockResolvedValue(rewardReceipt());
        await mount({
          taskPlanPort: plan,
          taskActions: { complete: vi.fn(), undo: vi.fn(), atomic },
        });
        await click('开始 Open one');
        await typeNotes('第三节先写结论');
        await click('完成 Open one');
        expect(plan.updateTask).toHaveBeenCalledExactlyOnceWith('open-one', {
          notes: '第三节先写结论',
        });
        expect(atomic).toHaveBeenCalledExactlyOnceWith('open-one', today, true, now);
        expect(container.querySelector('[data-allowance-stat="balance"]')?.textContent).toContain(
          String(TASK_REWARD),
        );
        expect(liveStatus()).toEqual([`已完成，+${TASK_REWARD} 元零花钱。`]);
      });

      it('does not complete, and moves no money, when the note cannot be saved', async () => {
        stubCardStorage();
        const plan = { ...port(), updateTask: vi.fn().mockRejectedValue(new Error('disk full')) };
        const atomic = vi.fn();
        await mount({
          taskPlanPort: plan,
          taskActions: { complete: vi.fn(), undo: vi.fn(), atomic },
        });
        await click('开始 Open one');
        await typeNotes('第三节先写结论');
        await click('完成 Open one');
        expect(atomic).not.toHaveBeenCalled();
        expect(working()).toBe(true);
        expect(notesValue()).toBe('第三节先写结论');
        expect(container.querySelector('.home-working-notes-status')?.textContent).toBe(
          '没保存，请重试',
        );
      });

      it('waits for the note before leaving Home, and stays when it cannot be saved', async () => {
        stubCardStorage();
        const plan = port();
        await mount({ taskPlanPort: plan });
        await click('开始 Open one');
        const field = container.querySelector<HTMLTextAreaElement>('#home-working-notes-input');
        await act(async () => field?.focus());
        await typeNotes('第三节先写结论');
        let left = false;
        await act(async () => {
          left = await requestEditorLeaveAsync();
        });
        expect(left).toBe(true);
        expect(plan.updateTask).toHaveBeenCalledExactlyOnceWith('open-one', {
          notes: '第三节先写结论',
        });

        plan.updateTask.mockRejectedValue(new Error('disk full'));
        await typeNotes('第三节先写结论，再补证据');
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
        try {
          await act(async () => {
            left = await requestEditorLeaveAsync();
          });
          expect(left).toBe(false);
          expect(confirm).toHaveBeenCalledOnce();
          expect(notesValue()).toBe('第三节先写结论，再补证据');
          expect(container.querySelector('.home-working-notes-status')?.textContent).toBe(
            '没保存，请重试',
          );
        } finally {
          confirm.mockRestore();
        }
      });

      it('sets aside a note its deleted task can no longer take, and frees the next card', async () => {
        const values = stubCardStorage();
        const plan = {
          ...port(),
          updateTask: vi.fn().mockRejectedValue(new Error('Task open-one was not found.')),
        };
        const atomic = vi.fn().mockResolvedValue(rewardReceipt());
        await mount({
          taskPlanPort: plan,
          taskActions: { complete: vi.fn(), undo: vi.fn(), atomic },
          taskSummary: overview(),
        });
        await click('开始 Open one');
        await typeNotes('第三节先写结论');
        expect(notesValue()).toBe('第三节先写结论');
        // The task was deleted in another window, and the next refresh shows the other one.
        await act(async () =>
          root.render(
            view({
              taskPlanPort: plan,
              taskActions: { complete: vi.fn(), undo: vi.fn(), atomic },
              taskSummary: taskSummaryFromOverview(buildHomeTaskOverview([other], [], [], today)),
            }),
          ),
        );
        expect(working()).toBe(false);
        expect(container.querySelector('.home-working-stranded')?.textContent).toContain(
          '第三节先写结论',
        );
        expect(values['valrecall.workingCard']).toBeDefined();
        await click('开始 Open two');
        await click('完成 Open two');
        expect(atomic).toHaveBeenCalledOnce();
        expect(container.querySelector('.home-working-stranded')?.textContent).toContain(
          '第三节先写结论',
        );
      });

      it('asks before leaving Home with a note that could not be saved', async () => {
        stubCardStorage();
        const plan = { ...port(), updateTask: vi.fn().mockRejectedValue(new Error('disk full')) };
        await mount({ taskPlanPort: plan });
        await click('开始 Open one');
        const field = container.querySelector<HTMLTextAreaElement>('#home-working-notes-input');
        await act(async () => field?.focus());
        // Nothing to lose yet: leaving saves the text on the way out.
        await typeNotes('第三节先写结论');
        expect(requestEditorLeave()).toBe(true);
        await act(async () => field?.blur());
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
        try {
          expect(requestEditorLeave()).toBe(false);
          expect(confirm).toHaveBeenCalledOnce();
        } finally {
          confirm.mockRestore();
        }
      });
    });

    it('skips through the plan port, announces it, and offers undo, with no reward', async () => {
      stubCardStorage();
      const plan = {
        changeTaskSkipAtomic: vi.fn().mockResolvedValue({ changed: true }),
        updateTask: vi.fn(),
        archiveTask: vi.fn(),
      };
      const atomic = vi.fn();
      await mount({
        taskPlanPort: plan,
        taskActions: { complete: vi.fn(), undo: vi.fn(), atomic },
      });
      await click('更多 Open one');
      await click('今天不做 Open one');
      expect(plan.changeTaskSkipAtomic).toHaveBeenCalledExactlyOnceWith(
        'skip-task',
        'open-one',
        today,
        now,
      );
      expect(atomic).not.toHaveBeenCalled();
      expect(container.querySelector('.home-task-undo')?.textContent).toContain('今天已跳过');
      await click('撤销 Open one');
      expect(plan.changeTaskSkipAtomic).toHaveBeenLastCalledWith(
        'restore-task',
        'open-one',
        today,
        now,
      );
    });

    it('reports a failed skip and offers no undo', async () => {
      stubCardStorage();
      const plan = {
        changeTaskSkipAtomic: vi
          .fn()
          .mockRejectedValue(new Error('该次待办已变更，请同步后核对。')),
        updateTask: vi.fn(),
        archiveTask: vi.fn(),
      };
      await mount({ taskPlanPort: plan });
      await click('更多 Open one');
      await click('今天不做 Open one');
      expect(container.querySelector('.home-task-undo')).toBeNull();
      expect(container.textContent).toContain('该次待办已变更，请同步后核对。');
    });

    it('refuses a stale recurring row after midnight without touching it', async () => {
      stubCardStorage();
      let current = now;
      const plan = {
        changeTaskSkipAtomic: vi.fn(),
        updateTask: vi.fn(),
        archiveTask: vi.fn(),
      };
      await mount({ taskPlanPort: plan, clock: () => current });
      await click('更多 Open one');
      current = new Date(2026, 9, 31, 0, 1);
      await click('今天不做 Open one');
      expect(plan.changeTaskSkipAtomic).not.toHaveBeenCalled();
      expect(container.textContent).toContain('任务日期已变化，请刷新后再操作。');
    });

    it('turned off: no 开始 and no card, and skip stays available', async () => {
      const values = stubCardStorage();
      values['valrecall.workingCard'] = { version: 1, enabled: false };
      await mount();
      expect(container.querySelector('[aria-label="开始 Open one"]')).toBeNull();
      expect(container.querySelector('[aria-label="更多 Open one"]')).not.toBeNull();
    });
  });
});
