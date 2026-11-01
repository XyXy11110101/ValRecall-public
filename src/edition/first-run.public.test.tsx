import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DashboardApp } from '../dashboard/DashboardApp';
import { HomeView } from '../dashboard/HomeView';
import { LibraryView } from '../dashboard/LibraryView';
import { repository } from '../dashboard/services';
import { TasksView } from '../dashboard/TasksView';
import { TodayView } from '../dashboard/TodayView';
import { localDateKey } from '../models/daily-task';
import { DEFAULT_PREFERENCES } from '../shared/preferences';
import { SidePanelApp } from '../sidepanel/SidePanelApp';
import { installDraftMemoryPort } from '../testing/draft-port';
import { onAddQuestionRequested } from './add-question-event';

// HomeView reads the flag once on load to decide on its lazy card, so it is set before any import.
vi.hoisted(() => Object.assign(globalThis, { __VALRECALL_PUBLIC_RELEASE__: true }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CAUGHT_UP = /跟上/u;

function stubBrowser({ savedOnce = false, shortcut = 'Ctrl+Shift+Y' } = {}) {
  const create = vi.fn().mockResolvedValue({});
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn().mockResolvedValue(savedOnce ? { 'valrecall.savedItemOnce': true } : {}),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
    commands: {
      getAll: vi.fn().mockResolvedValue([{ name: 'capture-learning-moment', shortcut }]),
    },
    tabs: { create },
  });
  return { create };
}

describe('first run, public edition', () => {
  let container: HTMLDivElement;
  let root: Root;

  const button = (name: string) =>
    Array.from(container.querySelectorAll('button')).find((entry) =>
      entry.textContent?.includes(name),
    );

  async function waitFor(check: () => void) {
    for (let attempt = 0; ; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      try {
        check();
        return;
      } catch (error) {
        if (attempt >= 100) throw error;
      }
    }
  }

  beforeEach(() => {
    installDraftMemoryPort();
    window.history.replaceState({}, '', '/dashboard.html');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const home = (
    <HomeView
      revision={0}
      onStartReview={() => undefined}
      onAddQuestion={() => undefined}
      loadItems={async () => []}
      loadTaskSummary={async (localDate) => ({
        localDate,
        total: 0,
        completed: 0,
        remaining: 0,
        occurrences: [],
      })}
    />
  );

  it('shows the three steps and the real key to someone who never saved anything', async () => {
    stubBrowser();
    await act(async () => root.render(home));
    await waitFor(() => expect(container.querySelector('.first-run-card')).not.toBeNull());

    const steps = Array.from(container.querySelectorAll('.first-run-steps strong'));
    expect(steps.map((step) => step.textContent)).toEqual(['打开视频', '按快捷键', '写问题']);
    await waitFor(() =>
      expect(container.querySelector('.first-run-steps kbd')?.textContent).toBe('Ctrl+Shift+Y'),
    );
    expect(container.textContent).toContain('还没有内容。先存一条吧。');
    expect(container.textContent).not.toMatch(CAUGHT_UP);
  });

  it('says when no key is set and opens the shortcut page', async () => {
    const { create } = stubBrowser({ shortcut: '' });
    await act(async () => root.render(home));
    await waitFor(() => expect(button('去设置快捷键')).toBeDefined());

    expect(container.textContent).toContain('还没有设置快捷键。设置好才能捕获。');
    act(() => button('去设置快捷键')!.click());
    expect(create).toHaveBeenCalledExactlyOnceWith({ url: 'edge://extensions/shortcuts' });
  });

  it('keeps the card away and says caught up once something was saved', async () => {
    stubBrowser({ savedOnce: true });
    await act(async () => root.render(home));
    await waitFor(() => expect(container.textContent).toContain('今天都跟上进度了。'));
    expect(container.querySelector('.first-run-card')).toBeNull();
  });

  it('lets the all-done state win on Home for someone with no recall items', async () => {
    stubBrowser();
    await act(async () =>
      root.render(
        <HomeView
          revision={0}
          onStartReview={() => undefined}
          onAddQuestion={() => undefined}
          loadItems={async () => []}
          loadTaskSummary={async (localDate) => ({
            localDate,
            total: 1,
            completed: 1,
            remaining: 0,
            occurrences: [],
          })}
        />,
      ),
    );
    await waitFor(() => expect(container.textContent).toContain('今天都跟上进度了。'));
    expect(container.textContent).not.toContain('还没有内容。先存一条吧。');
  });

  function today() {
    return (
      <TodayView
        revision={0}
        preferences={DEFAULT_PREFERENCES}
        onChanged={() => undefined}
        onGoHome={() => undefined}
        onGoLibrary={() => undefined}
        loadDueItems={async () => []}
        loadCategorySummaries={async () => []}
      />
    );
  }

  it('gives the empty Review a way to add instead of saying caught up', async () => {
    stubBrowser();
    const requested = vi.fn();
    const stop = onAddQuestionRequested(requested);
    await act(async () => root.render(today()));
    await waitFor(() => expect(container.textContent).toContain('还没有内容'));

    expect(container.textContent).toContain('先存一条内容。到时间，这里会提醒你复习。');
    expect(container.textContent).not.toMatch(CAUGHT_UP);
    expect(button('查看即将到期')).toBeUndefined();
    act(() => button('添加回忆题')!.click());
    expect(requested).toHaveBeenCalledOnce();
    stop();
  });

  it('keeps the ordinary empty Review once something was saved', async () => {
    stubBrowser({ savedOnce: true });
    await act(async () => root.render(today()));
    await waitFor(() => expect(container.textContent).toContain('都跟上了'));
    expect(button('查看即将到期')).toBeDefined();
    expect(button('添加回忆题')).toBeUndefined();
  });

  it('opens the add form from the empty Review', async () => {
    stubBrowser();
    window.history.replaceState({}, '', '/dashboard.html?view=review');
    await act(async () =>
      root.render(<DashboardApp preferenceLoader={async () => DEFAULT_PREFERENCES} />),
    );
    await waitFor(() => expect(container.textContent).toContain('还没有内容'));
    const add = Array.from(container.querySelectorAll('.review-entry-controls button')).find(
      (entry) => entry.textContent === '添加回忆题',
    ) as HTMLButtonElement;
    await act(async () => add.click());
    await waitFor(() => expect(window.location.search).toBe('?view=add'));
  });

  it('does not tell a new user on the task page that reviews are done', async () => {
    stubBrowser();
    await act(async () => root.render(<TasksView revision={0} onChanged={() => undefined} />));
    await waitFor(() => expect(container.textContent).toContain('还没有内容。先存一条吧。'));
    expect(container.textContent).not.toMatch(CAUGHT_UP);
  });

  it('lets the all-done state win on the task page', async () => {
    stubBrowser();
    const date = localDateKey(new Date());
    const task = await repository.createTask({
      title: '今天的事',
      kind: 'one_off',
      scheduledDate: date,
      recurrence: 'specific_date',
    });
    await repository.completeTaskForDate(task.id, date);
    await act(async () => root.render(<TasksView revision={0} onChanged={() => undefined} />));
    await waitFor(() => expect(container.textContent).toContain('今天都跟上进度了。'));
    expect(container.textContent).not.toContain('还没有内容。先存一条吧。');
    await repository.clearAllData();
  });

  it('uses the real key in the empty library', async () => {
    stubBrowser();
    await act(async () =>
      root.render(
        <LibraryView revision={0} preferences={DEFAULT_PREFERENCES} onChanged={() => undefined} />,
      ),
    );
    await waitFor(() =>
      expect(container.textContent).toContain('点「添加回忆题」，或在视频里按 Ctrl+Shift+Y。'),
    );
  });

  it('uses the real key in the side panel', async () => {
    stubBrowser({ shortcut: '' });
    await act(async () =>
      root.render(<SidePanelApp loadDueCount={async () => 0} loadCategories={async () => []} />),
    );
    await waitFor(() =>
      expect(container.querySelector('.companion-hero h2')?.textContent).toBe(
        '还没有设置捕获快捷键',
      ),
    );
  });
});
