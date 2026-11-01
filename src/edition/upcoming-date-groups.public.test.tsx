import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { State, createEmptyCard } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpcomingReviewsView } from '../dashboard/UpcomingReviewsView';
import type {
  ListUpcomingReviewItemsOptions,
  UpcomingReviewItemsPage,
  VideoLearningItem,
} from '../database';
import { DEFAULT_PREFERENCES } from '../shared/preferences';

// Only in the public repository: it checks lines the export rewrites in this view.
vi.hoisted(() => Object.assign(globalThis, { __VALRECALL_PUBLIC_RELEASE__: true }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const start = new Date(2026, 6, 21, 12, 0, 30);
const reminderStatus = async () => ({
  ok: true as const,
  status: { nextReviewReminderAt: null, notificationPermission: 'granted' as const },
});
const onePage = (items: VideoLearningItem[]): UpcomingReviewItemsPage => ({
  items,
  nextCursor: null,
  hasMore: false,
  invalidCount: 0,
});

describe('upcoming date groups, public edition', () => {
  let container: HTMLDivElement;
  let root: Root;
  let renderLoop: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    // Throwing ends a render loop here. In a real page it would never stop.
    renderLoop = vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
      if (String(message).includes('Maximum update depth')) throw new Error('Render loop.');
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function render(
    loadUpcoming: (options: ListUpcomingReviewItemsOptions) => Promise<UpcomingReviewItemsPage>,
    revision = 0,
  ) {
    await act(async () => {
      root.render(
        <UpcomingReviewsView
          revision={revision}
          preferences={DEFAULT_PREFERENCES}
          onViewItem={() => undefined}
          onOpenReminderSettings={() => undefined}
          loadUpcoming={loadUpcoming}
          loadDueCount={async () => 0}
          reminderStatusLoader={reminderStatus}
          clock={() => new Date()}
        />,
      );
      await drain();
    });
  }

  function group(label: string) {
    const found = [...container.querySelectorAll('.upcoming-bucket-button')].find((entry) =>
      entry.textContent?.startsWith(label),
    );
    if (!found) throw new Error(`Missing group: ${label}`);
    return found as HTMLButtonElement;
  }

  function isOpen(label: string) {
    return group(label).getAttribute('aria-expanded') === 'true';
  }

  async function click(target: Element | undefined) {
    await act(async () => {
      (target as HTMLElement).click();
      await drain();
    });
  }

  function exactButton(label: string) {
    return [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === label,
    );
  }

  it('lets the last open group be closed, and keeps it closed', async () => {
    const loadUpcoming = vi.fn(async () => onePage([item('today', hoursFromStart(7))]));
    await render(loadUpcoming);
    expect(isOpen('今天')).toBe(true);

    await click(group('今天'));
    expect(isOpen('今天')).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      await drain();
    });
    expect(isOpen('今天')).toBe(false);

    await render(loadUpcoming, 1);
    expect(isOpen('今天')).toBe(false);
  });

  it('can open again what was closed', async () => {
    await render(async () => onePage([item('today', hoursFromStart(7))]));
    await click(group('今天'));
    await click(group('今天'));
    expect(isOpen('今天')).toBe(true);
  });

  it('opens the defaults again after the range changes', async () => {
    await render(async () => onePage([item('today', hoursFromStart(7))]));
    await click(group('今天'));
    expect(isOpen('今天')).toBe(false);

    await click(exactButton('30 天'));
    expect(isOpen('今天')).toBe(true);
  });

  it('still opens today and tomorrow by default', async () => {
    await render(async () =>
      onePage([item('today', hoursFromStart(7)), item('tomorrow', hoursFromStart(24))]),
    );
    expect(isOpen('今天')).toBe(true);
    expect(isOpen('明天')).toBe(true);
    expect(isOpen('更晚')).toBe(false);
  });

  it('settles when nothing is due today or tomorrow', async () => {
    await render(async () => onePage([item('later', hoursFromStart(24 * 4))]));

    expect(renderLoop).not.toHaveBeenCalled();
    expect(container.textContent).toContain('已加载 1 条');
    expect(isOpen('今天')).toBe(false);
    expect(isOpen('明天')).toBe(false);
  });

  it('shows no failure from the old range after the range changed', async () => {
    let failOld: (reason: Error) => void = () => undefined;
    const first = [item('row-0', hoursFromStart(7))];
    const loadUpcoming = vi.fn(
      async (options: ListUpcomingReviewItemsOptions): Promise<UpcomingReviewItemsPage> =>
        options.cursor
          ? new Promise((_resolve, reject) => {
              failOld = reject;
            })
          : {
              items: first,
              nextCursor: { due: first[0]!.fsrsCard.due.toISOString(), itemId: 'row-0' },
              hasMore: true,
              invalidCount: 0,
            },
    );
    await render(loadUpcoming);

    await click(exactButton('加载更多'));
    expect(exactButton('加载中…')).toBeDefined();

    await click(exactButton('30 天'));
    await act(async () => {
      failOld(new Error('old range failed'));
      await drain();
    });

    expect(container.textContent).not.toContain('old range failed');
    expect(container.querySelector('.motion-state-change')).toBeNull();
  });

  it('still shows a failure from the range on screen', async () => {
    const first = [item('row-0', hoursFromStart(7))];
    const loadUpcoming = vi.fn(
      async (options: ListUpcomingReviewItemsOptions): Promise<UpcomingReviewItemsPage> => {
        if (options.cursor) throw new Error('this range failed');
        return {
          items: first,
          nextCursor: { due: first[0]!.fsrsCard.due.toISOString(), itemId: 'row-0' },
          hasMore: true,
          invalidCount: 0,
        };
      },
    );
    await render(loadUpcoming);

    await click(exactButton('加载更多'));

    expect(container.querySelector('.motion-state-change')?.textContent).toContain(
      'this range failed',
    );
    expect(exactButton('加载更多')).toBeDefined();
  });
});

function hoursFromStart(hours: number): Date {
  return new Date(start.getTime() + hours * 3_600_000);
}

async function drain() {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
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
