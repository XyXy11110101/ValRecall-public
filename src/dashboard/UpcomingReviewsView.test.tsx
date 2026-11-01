import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { State, createEmptyCard } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ImageLearningItem,
  ListUpcomingReviewItemsOptions,
  LearningItem,
  UpcomingReviewItemsPage,
  VideoLearningItem,
} from '../database';
import { DEFAULT_PREFERENCES } from '../shared/preferences';
import { UpcomingReviewsView } from './UpcomingReviewsView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = new Date(2026, 6, 21, 12);
const grantedStatus = async () => ({
  ok: true as const,
  status: {
    nextReviewReminderAt: new Date(2026, 6, 21, 19, 40).toISOString(),
    notificationPermission: 'granted' as const,
  },
});

describe('UpcomingReviewsView', () => {
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
    vi.useRealTimers();
  });

  it('shows bucket/cohort disclosure, five bounded rows and no future rating controls', async () => {
    const values = [
      ...Array.from({ length: 7 }, (_, index) =>
        item(`today-${index}`, new Date(2026, 6, 21, 19, 40, index)),
      ),
      item('tomorrow', new Date(2026, 6, 22, 10, 15)),
      item('week', new Date(2026, 6, 24, 14, 30)),
    ];
    const loadUpcoming = vi.fn().mockResolvedValue(page(values));
    const onViewItem = vi.fn();
    await render({ loadUpcoming, loadDueCount: vi.fn().mockResolvedValue(2), onViewItem });

    expect(loadUpcoming).toHaveBeenCalledWith(
      expect.objectContaining({ after: now, limit: 50, before: expect.any(Date) }),
    );
    expect(container.textContent).toContain('今天');
    expect(container.textContent).toContain('明天');
    expect(container.textContent).toContain('未来 7 天');
    expect(container.textContent).toContain('现在有 2 条复习可以开始');
    expect(container.textContent).toContain('提醒时间：今天 19:40');

    const cohort = container.querySelector<HTMLButtonElement>('.upcoming-cohort-button');
    act(() => cohort?.click());
    expect(container.querySelectorAll('.upcoming-item-row')).toHaveLength(5);
    expect(container.textContent).not.toContain('Private answer');
    expect(container.querySelector('img')).toBeNull();
    expect(ratingButtons()).toEqual([]);
    expect(button('打开来源')).toBeDefined();
    expect(button('查看或编辑')).toBeDefined();

    act(() => button('再显示 2 条')?.click());
    expect(container.querySelectorAll('.upcoming-item-row')).toHaveLength(7);
    act(() => itemControl('收起')?.click());
    expect(container.querySelectorAll('.upcoming-item-row')).toHaveLength(5);

    act(() => button('查看或编辑')?.click());
    expect(onViewItem).toHaveBeenCalledWith(values[0]);
  });

  it('shows Image as a source label while reserving Open source for manual Video', async () => {
    const due = new Date(2026, 6, 21, 19, 40);
    const image = imageItem('image-upcoming', due);
    const manualVideo = item('manual-upcoming', due);
    manualVideo.sourceType = 'video';
    manualVideo.videoOrigin = 'library';
    manualVideo.timestampSeconds = null;
    manualVideo.timestampDisplay = null;
    manualVideo.screenshotId = null;
    const onViewItem = vi.fn();

    await render({
      loadUpcoming: vi.fn().mockResolvedValue(page([image, manualVideo])),
      onViewItem,
    });
    act(() => container.querySelector<HTMLButtonElement>('.upcoming-cohort-button')?.click());

    expect(container.textContent).toContain('图片');
    expect(container.textContent).toContain(image.title);
    expect(container.textContent).toContain(manualVideo.videoTitle);
    expect(exactButtons('打开来源')).toHaveLength(1);
    expect(exactButtons('查看或编辑')).toHaveLength(2);
    expect(container.querySelector('img')).toBeNull();

    act(() => exactButtons('查看或编辑')[0]?.click());
    expect(onViewItem).toHaveBeenCalledWith(image);
  });

  it('uses bounded 7/30/All queries and paginates All through a visible Load more control', async () => {
    const firstAll = item('all-first', new Date(2026, 7, 22, 12));
    const secondAll = item('all-second', new Date(2026, 8, 22, 12));
    const loadUpcoming = vi.fn(
      async (options: ListUpcomingReviewItemsOptions): Promise<UpcomingReviewItemsPage> => {
        if (options.cursor) return page([secondAll]);
        if (options.before) return page([item('bounded', new Date(2026, 6, 22, 12))]);
        return {
          items: [firstAll],
          nextCursor: { due: firstAll.fsrsCard.due.toISOString(), itemId: firstAll.id },
          hasMore: true,
          invalidCount: 0,
        };
      },
    );
    await render({ loadUpcoming });

    act(() => button('30 天')?.click());
    await flush();
    const thirtyCall = loadUpcoming.mock.calls.at(-1)?.[0];
    expect(thirtyCall?.before?.getTime()).toBe(new Date(2026, 7, 20, 12).getTime());

    act(() => button('全部')?.click());
    await flush();
    const allCall = loadUpcoming.mock.calls.at(-1)?.[0];
    expect(allCall?.before).toBeUndefined();
    expect(container.textContent).toContain('已加载 1 条复习；还有更多');
    expect(button('加载更多')).toBeDefined();

    await act(async () => {
      button('加载更多')?.click();
      await Promise.resolve();
    });
    expect(loadUpcoming.mock.calls.at(-1)?.[0].cursor).toEqual({
      due: firstAll.fsrsCard.due.toISOString(),
      itemId: firstAll.id,
    });
    expect(container.textContent).toContain('已加载 2 条');
  });

  it('keeps a 300-item source bounded to one 50-record page and renders no item rows by default', async () => {
    const values = Array.from({ length: 50 }, (_, index) =>
      item(`bulk-${index.toString().padStart(3, '0')}`, new Date(2026, 6, 21, 19, 40, index % 60)),
    );
    const loadUpcoming = vi.fn().mockResolvedValue({
      items: values,
      nextCursor: {
        due: values.at(-1)!.fsrsCard.due.toISOString(),
        itemId: values.at(-1)!.id,
      },
      hasMore: true,
      invalidCount: 0,
    });
    await render({ loadUpcoming });

    expect(loadUpcoming).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    expect(container.textContent).toContain('已加载 50 条');
    expect(container.querySelectorAll('.upcoming-cohort')).toHaveLength(1);
    expect(container.querySelectorAll('.upcoming-item-row')).toHaveLength(0);
    expect(container.querySelector('img')).toBeNull();
    expect(button('加载更多')).toBeDefined();
  });

  it('re-queries on the shared minute clock and moves a newly due card out of Upcoming', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T12:00:30.000Z'));
    const due = new Date('2026-07-21T12:01:00.000Z');
    const futureItem = item('becoming-due', due);
    const loadUpcoming = vi.fn(async (options: ListUpcomingReviewItemsOptions) =>
      page(options.after.getTime() < due.getTime() ? [futureItem] : []),
    );
    const loadDueCount = vi.fn(async (at: Date) => (at.getTime() >= due.getTime() ? 1 : 0));

    await render({
      loadUpcoming,
      loadDueCount,
      clock: () => new Date(),
    });
    expect(container.textContent).toContain('已加载 1 条');

    await act(async () => {
      vi.advanceTimersByTime(30_020);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadUpcoming).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('现在有 1 条复习可以开始');
    expect(container.textContent).toContain('这个范围内没有更晚的复习安排');
  });

  async function render({
    loadUpcoming,
    loadDueCount = vi.fn().mockResolvedValue(0),
    onViewItem = () => undefined,
    clock = () => now,
  }: {
    loadUpcoming: (options: ListUpcomingReviewItemsOptions) => Promise<UpcomingReviewItemsPage>;
    loadDueCount?: (now: Date) => Promise<number>;
    onViewItem?: (item: LearningItem) => void;
    clock?: () => Date;
  }) {
    await act(async () => {
      root.render(
        <UpcomingReviewsView
          revision={0}
          preferences={DEFAULT_PREFERENCES}
          onViewItem={onViewItem}
          onOpenReminderSettings={() => undefined}
          loadUpcoming={loadUpcoming}
          loadDueCount={loadDueCount}
          reminderStatusLoader={grantedStatus}
          clock={clock}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

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

  function ratingButtons(): string[] {
    return [...container.querySelectorAll('button')]
      .map((candidate) => candidate.textContent ?? '')
      .filter((label) => ['Again', 'Hard', 'Good', 'Easy'].includes(label));
  }

  function exactButtons(label: string): HTMLButtonElement[] {
    return [...container.querySelectorAll('button')].filter(
      (candidate) => candidate.textContent === label,
    );
  }
});

function page(items: LearningItem[]): UpcomingReviewItemsPage {
  return { items, nextCursor: null, hasMore: false, invalidCount: 0 };
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
    personalNote: 'Private note',
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

function imageItem(id: string, due: Date): ImageLearningItem {
  return {
    id,
    schemaVersion: 2,
    sourceType: 'image',
    title: `Image ${id}`,
    imageAssetId: `asset-${id}`,
    imageMimeType: 'image/webp',
    imageWidth: 1200,
    imageHeight: 800,
    categoryId: null,
    itemType: 'Notice',
    personalNote: '',
    situation: '',
    coreLesson: `Core ${id}`,
    mistakeToAvoid: '',
    recommendedAction: '',
    reason: '',
    recallPrompt: `Question ${id}`,
    referenceAnswer: `Private answer ${id}`,
    tags: [],
    createdAt: new Date(2026, 6, 20),
    updatedAt: new Date(2026, 6, 20),
    fsrsCard: createEmptyCard(due),
    reviewHistory: [],
    suspended: false,
    extractionDiagnostics: [],
  };
}
