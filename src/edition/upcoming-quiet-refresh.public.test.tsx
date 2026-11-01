import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { State, createEmptyCard } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpcomingReviewsView } from '../dashboard/UpcomingReviewsView';
import type {
  LearningItem,
  ListUpcomingReviewItemsOptions,
  UpcomingReviewItemsPage,
  VideoLearningItem,
} from '../database';
import { openSourceAtTimestamp } from '../shared/extension';
import { DEFAULT_PREFERENCES } from '../shared/preferences';
import { loadUpcomingPages } from './upcoming-refresh';

vi.hoisted(() => Object.assign(globalThis, { __VALRECALL_PUBLIC_RELEASE__: true }));

vi.mock('../shared/extension', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/extension')>()),
  openSourceAtTimestamp: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const start = new Date(2026, 6, 21, 12, 0, 30);
const reminderStatus = async () => ({
  ok: true as const,
  status: { nextReviewReminderAt: null, notificationPermission: 'granted' as const },
});

/** A stand-in for the repository: every page starts after the cursor, in due order. */
function pagedLoader(items: LearningItem[]) {
  return vi.fn(
    async (options: ListUpcomingReviewItemsOptions): Promise<UpcomingReviewItemsPage> => {
      const future = items.filter((entry) => entry.fsrsCard.due > options.after);
      const from = options.cursor
        ? future.findIndex((entry) => entry.id === options.cursor?.itemId) + 1
        : 0;
      const slice = future.slice(from, from + options.limit);
      const hasMore = from + options.limit < future.length;
      const last = slice.at(-1);
      return {
        items: slice,
        nextCursor:
          hasMore && last ? { due: last.fsrsCard.due.toISOString(), itemId: last.id } : null,
        hasMore,
        invalidCount: 0,
      };
    },
  );
}

describe('upcoming reviews time tick, public edition', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(openSourceAtTimestamp).mockResolvedValue({ ok: true } as Awaited<
      ReturnType<typeof openSourceAtTimestamp>
    >);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps the notice, the open group and the shown rows through a minute tick', async () => {
    const values = sevenAtOneMinute();
    const loadUpcoming = pagedLoader(values);
    await render(loadUpcoming);

    await openFirstCohortAndShowAll();
    await act(async () => exactButtons('打开来源')[0]?.click());
    expect(container.textContent).toContain('已打开「Lesson row-0」');

    await minuteTick();

    expect(loadUpcoming.mock.calls.length).toBeGreaterThan(1);
    expect(container.textContent).toContain('已打开「Lesson row-0」');
    expect(firstCohortButton()?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('.upcoming-item-row')).toHaveLength(7);
  });

  it('keeps them through a return to the tab as well', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const loadUpcoming = pagedLoader(sevenAtOneMinute());
    await render(loadUpcoming);

    await openFirstCohortAndShowAll();
    await act(async () => exactButtons('打开来源')[0]?.click());

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await drain();
    });
    visibility.mockRestore();

    expect(loadUpcoming).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('已打开「Lesson row-0」');
    expect(firstCohortButton()?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('.upcoming-item-row')).toHaveLength(7);
  });

  it('shows no refreshing state during a tick', async () => {
    const values = sevenAtOneMinute();
    let release: (value: UpcomingReviewItemsPage) => void = () => undefined;
    const loadUpcoming = pagedLoader(values);
    await render(loadUpcoming);

    loadUpcoming.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await minuteTick();

    expect(container.textContent).not.toContain('正在刷新');
    expect(container.querySelector('.upcoming-review-view')?.getAttribute('aria-busy')).toBe(
      'false',
    );
    await act(async () => {
      release({ items: values, nextCursor: null, hasMore: false, invalidCount: 0 });
      await drain();
    });
  });

  it('keeps every page that "load more" brought in, and still refreshes them', async () => {
    const values = manyItems(130);
    const loadUpcoming = pagedLoader(values);
    await render(loadUpcoming);

    await loadMore();
    await loadMore();
    expect(container.textContent).toContain('已加载 130 条复习');

    // The record on the last page changes while the view is open.
    values[129] = item('row-129-new', values[129]!.fsrsCard.due);
    await minuteTick();

    expect(container.textContent).toContain('已加载 130 条复习');
    expect(hasRow('row-129-new')).toBe(true);
    expect(loadUpcoming.mock.calls.every(([options]) => options.limit <= 50)).toBe(true);
  });

  it('can still load the next page after a tick', async () => {
    const loadUpcoming = pagedLoader(manyItems(130));
    await render(loadUpcoming);

    await loadMore();
    expect(container.textContent).toContain('已加载 100 条复习；还有更多');
    await minuteTick();
    expect(container.textContent).toContain('已加载 100 条复习；还有更多');

    await loadMore();
    expect(container.textContent).toContain('已加载 130 条复习');
    expect(container.textContent).not.toContain('还有更多');
  });

  it('drops a record that became due during a tick and reports it as due', async () => {
    const due = new Date(start.getTime() + 30_000);
    const loadUpcoming = pagedLoader([item('becoming-due', due)]);
    const loadDueCount = vi.fn(async (at: Date) => (at >= due ? 1 : 0));
    await render(loadUpcoming, loadDueCount);
    expect(container.textContent).toContain('已加载 1 条');

    await minuteTick();

    expect(container.textContent).toContain('已加载 0 条');
    expect(container.textContent).toContain('现在有 1 条复习可以开始');
  });

  it('does not throw away a "load more" that is still running when a tick arrives', async () => {
    const values = manyItems(70);
    const loadUpcoming = pagedLoader(values);
    await render(loadUpcoming);

    const realLoad = loadUpcoming.getMockImplementation()!;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    loadUpcoming.mockImplementationOnce(async (options) => {
      await held;
      return realLoad(options);
    });
    await act(async () => exactButtons('加载更多')[0]?.click());
    expect(exactButtons('加载中…')).toHaveLength(1);

    await minuteTick();
    await act(async () => {
      release();
      await drain();
    });

    expect(container.textContent).toContain('已加载 70 条复习');
    expect(exactButtons('加载中…')).toHaveLength(0);
  });

  it('does not take back a "load more" pressed while a tick is still reading', async () => {
    const values = manyItems(70);
    const loadUpcoming = pagedLoader(values);
    await render(loadUpcoming);

    const realLoad = loadUpcoming.getMockImplementation()!;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    loadUpcoming.mockImplementationOnce(async (options) => {
      await held;
      return realLoad(options);
    });
    await minuteTick();
    await loadMore();
    expect(container.textContent).toContain('已加载 70 条复习');

    await act(async () => {
      release();
      await drain();
    });

    expect(container.textContent).toContain('已加载 70 条复习');
    expect(exactButtons('加载更多')).toHaveLength(0);

    // The tick that gave way is not lost: the next one reads all 70 again.
    loadUpcoming.mockClear();
    await minuteTick();
    expect(loadUpcoming.mock.calls.length).toBeGreaterThan(1);
    expect(container.textContent).toContain('已加载 70 条复习');
  });

  it('adds up the unreadable records across every page a tick reads', async () => {
    const pages: UpcomingReviewItemsPage[] = [
      {
        items: [item('a', new Date(2026, 6, 21, 13))],
        nextCursor: { due: new Date(2026, 6, 21, 13).toISOString(), itemId: 'a' },
        hasMore: true,
        invalidCount: 2,
      },
      {
        items: [item('b', new Date(2026, 6, 21, 14))],
        nextCursor: null,
        hasMore: false,
        invalidCount: 3,
      },
    ];
    const load = vi.fn(async () => pages.shift()!);
    const result = await loadUpcomingPages(load, { after: start }, 1, 2);
    expect(result.invalidCount).toBe(5);
    expect(result.items.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('resets everything when the range really changes', async () => {
    const loadUpcoming = pagedLoader(sevenAtOneMinute());
    await render(loadUpcoming);

    await openFirstCohortAndShowAll();
    await act(async () => exactButtons('打开来源')[0]?.click());
    expect(container.textContent).toContain('已打开「Lesson row-0」');

    await act(async () => {
      exactButtons('30 天')[0]?.click();
      await drain();
    });

    expect(container.textContent).not.toContain('已打开「Lesson row-0」');
    expect(firstCohortButton()?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('.upcoming-item-row')).toHaveLength(0);

    act(() => firstCohortButton()?.click());
    expect(container.querySelectorAll('.upcoming-item-row')).toHaveLength(5);
  });

  it('goes back to the first page when the range changes', async () => {
    const loadUpcoming = pagedLoader(manyItems(130));
    await render(loadUpcoming);
    await loadMore();
    expect(container.textContent).toContain('已加载 100 条复习');

    await act(async () => {
      exactButtons('30 天')[0]?.click();
      await drain();
    });

    expect(container.textContent).toContain('已加载 50 条复习；还有更多');
  });

  it('frees the "load more" button when the range changes while it is running', async () => {
    const loadUpcoming = pagedLoader(manyItems(130));
    await render(loadUpcoming);

    loadUpcoming.mockImplementationOnce(() => new Promise(() => undefined));
    await act(async () => exactButtons('加载更多')[0]?.click());
    expect(exactButtons('加载中…')).toHaveLength(1);

    await act(async () => {
      exactButtons('30 天')[0]?.click();
      await drain();
    });

    expect(exactButtons('加载中…')).toHaveLength(0);
    expect(exactButtons('加载更多')).toHaveLength(1);
  });

  it('a failed tick keeps the list, says so, and clears the message once it works again', async () => {
    const loadUpcoming = pagedLoader(sevenAtOneMinute());
    await render(loadUpcoming);
    expect(container.textContent).toContain('已加载 7 条');

    loadUpcoming.mockRejectedValueOnce(new Error('read failed'));
    await minuteTick();
    expect(container.textContent).toContain('已加载 7 条');
    expect(noticeText()).not.toBe('');

    await minuteTick();
    expect(noticeText()).toBe('');
    expect(container.textContent).toContain('已加载 7 条');
  });

  it('a failed tick does not replace a notice the person is reading', async () => {
    const loadUpcoming = pagedLoader(sevenAtOneMinute());
    await render(loadUpcoming);
    await openFirstCohortAndShowAll();
    await act(async () => exactButtons('打开来源')[0]?.click());

    loadUpcoming.mockRejectedValueOnce(new Error('read failed'));
    await minuteTick();
    expect(container.textContent).toContain('已打开「Lesson row-0」');

    await minuteTick();
    expect(container.textContent).toContain('已打开「Lesson row-0」');
  });

  it('a failed "load more" message stays through a tick, and a retry clears it', async () => {
    const loadUpcoming = pagedLoader(manyItems(70));
    await render(loadUpcoming);

    loadUpcoming.mockRejectedValueOnce(new Error('read failed'));
    await loadMore();
    expect(noticeText()).toContain('read failed');

    await minuteTick();
    expect(noticeText()).toContain('read failed');

    await loadMore();
    expect(noticeText()).toBe('');
    expect(container.textContent).toContain('已加载 70 条复习');
  });

  it('a tick retries a failed first load and clears its message', async () => {
    const loadUpcoming = pagedLoader(sevenAtOneMinute());
    loadUpcoming.mockRejectedValueOnce(new Error('read failed'));
    await render(loadUpcoming);
    expect(noticeText()).not.toBe('');

    await minuteTick();

    expect(noticeText()).toBe('');
    expect(container.textContent).toContain('已加载 7 条');
  });

  it('a tick clears the message from a failed range change', async () => {
    const loadUpcoming = pagedLoader(sevenAtOneMinute());
    await render(loadUpcoming);

    loadUpcoming.mockRejectedValueOnce(new Error('read failed'));
    await act(async () => {
      exactButtons('30 天')[0]?.click();
      await drain();
    });
    expect(noticeText()).not.toBe('');

    await minuteTick();

    expect(noticeText()).toBe('');
  });

  async function render(
    loadUpcoming: (options: ListUpcomingReviewItemsOptions) => Promise<UpcomingReviewItemsPage>,
    loadDueCount: (at: Date) => Promise<number> = async () => 0,
  ) {
    await act(async () => {
      root.render(
        <UpcomingReviewsView
          revision={0}
          preferences={DEFAULT_PREFERENCES}
          onViewItem={() => undefined}
          onOpenReminderSettings={() => undefined}
          loadUpcoming={loadUpcoming}
          loadDueCount={loadDueCount}
          reminderStatusLoader={reminderStatus}
          clock={systemTime}
        />,
      );
      await drain();
    });
  }

  async function minuteTick() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      await drain();
    });
  }

  async function loadMore() {
    await act(async () => {
      exactButtons('加载更多')[0]?.click();
      await drain();
    });
  }

  async function openFirstCohortAndShowAll() {
    act(() => firstCohortButton()?.click());
    expect(container.querySelectorAll('.upcoming-item-row')).toHaveLength(5);
    act(() => exactButtons('再显示 2 条')[0]?.click());
    expect(container.querySelectorAll('.upcoming-item-row')).toHaveLength(7);
  }

  function firstCohortButton() {
    return container.querySelector<HTMLButtonElement>('.upcoming-cohort-button');
  }

  function hasRow(id: string): boolean {
    for (const cohort of container.querySelectorAll<HTMLButtonElement>('.upcoming-cohort-button')) {
      if (cohort.getAttribute('aria-expanded') !== 'true') act(() => cohort.click());
      for (let shown = 0; shown < 40; shown += 1) {
        const more = [...container.querySelectorAll('button')].find((candidate) =>
          candidate.textContent?.startsWith('再显示'),
        );
        if (!more) break;
        act(() => more.click());
      }
      if (container.textContent?.includes(`Lesson ${id}`)) return true;
    }
    return false;
  }

  /** The text of the transient notice: the fixed warnings sit outside this wrapper. */
  function noticeText(): string {
    return container.querySelector('.motion-state-change')?.textContent ?? '';
  }

  function exactButtons(label: string): HTMLButtonElement[] {
    return [...container.querySelectorAll('button')].filter(
      (candidate) => candidate.textContent === label,
    );
  }
});

const systemTime = () => new Date();

async function drain() {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
}

function sevenAtOneMinute(): LearningItem[] {
  return Array.from({ length: 7 }, (_, index) =>
    item(`row-${index}`, new Date(2026, 6, 21, 19, 40, index)),
  );
}

function manyItems(count: number): LearningItem[] {
  return Array.from({ length: count }, (_, index) =>
    item(`row-${index}`, new Date(2026, 6, 21, 13, index)),
  );
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
    referenceAnswer: `Answer ${id}`,
    tags: [],
    createdAt: new Date(2026, 6, 20),
    updatedAt: new Date(2026, 6, 20),
    fsrsCard: card,
    reviewHistory: [],
    suspended: false,
    extractionDiagnostics: [],
  };
}
