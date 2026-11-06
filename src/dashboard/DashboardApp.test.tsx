import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEmptyCard } from 'ts-fsrs';
import type { LearningItem } from '../database';
import { repository } from './services';
import { installDraftMemoryPort } from '../testing/draft-port';
import { DraftRepository } from '../database/drafts';
import { DEFAULT_PREFERENCES } from '../shared/preferences';
import { DashboardApp } from './DashboardApp';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Lets the page work in small steps until `check` passes. A slow CI runner can need far longer
 * than any fixed wait: one 30 ms wait failed there on 2026-11-06.
 */
async function settleUntil(check: () => void | Promise<void>): Promise<void> {
  await vi.waitFor(
    async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      await check();
    },
    { timeout: 10_000, interval: 0 },
  );
}

describe('DashboardApp navigation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.history.replaceState({}, '', '/dashboard.html');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(document, 'startViewTransition');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('protects changed settings, restores canceled navigation and skips pristine prompts', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderApp();
    await act(async () => button('设置')!.click());
    await act(async () => button('首页')!.click());
    expect(confirm).not.toHaveBeenCalled();
    await act(async () => button('设置')!.click());
    const select = container.querySelector<HTMLSelectElement>('.settings-view select')!;
    act(() => {
      select.focus();
      select.value = 'Do';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => button('复习')!.click());
    expect(window.location.search).toBe('?view=settings');
    expect(select.value).toBe('Do');
    expect(document.activeElement).toBe(select);
    // Real managed back traversal must bounce to the editing history entry.
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(window.location.search).toBe('?view=settings');
    expect(activeTab()?.textContent).toBe('设置');
    expect(select.value).toBe('Do');
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    confirm.mockReturnValue(true);
    await act(async () => button('首页')!.click());
    expect(window.location.search).toBe('?view=home');
  });

  it('keeps the shell and navigation visible while preferences are loading', async () => {
    let resolvePreferences: ((value: typeof DEFAULT_PREFERENCES) => void) | undefined;
    const preferenceLoader = () =>
      new Promise<typeof DEFAULT_PREFERENCES>((resolve) => {
        resolvePreferences = resolve;
      });

    act(() => {
      root.render(
        <DashboardApp
          preferenceLoader={preferenceLoader}
          homeItemsLoader={async () => []}
          homeTaskSummaryLoader={async (localDate) => ({
            localDate,
            total: 0,
            completed: 0,
            remaining: 0,
            occurrences: [],
          })}
        />,
      );
    });

    expect(container.querySelector('header')).not.toBeNull();
    expect(navLabels()).toEqual(['首页', '资料库', '复习', '学习统计', '待办', '零花钱', '设置']);
    expect(
      [...container.querySelectorAll('.nav-tab')].every((tab) => tab.hasAttribute('disabled')),
    ).toBe(true);
    expect(container.querySelector('.dashboard-loading-state')?.textContent).toContain(
      '正在加载 ValRecall',
    );

    await act(async () => {
      resolvePreferences?.(DEFAULT_PREFERENCES);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('今天的学习');
  });

  it('defaults to Home and opens manual creation when no reviews are due', async () => {
    await renderApp();

    expect(container.textContent).toContain('今天的学习');
    expect(window.location.search).toBe('?view=home');
    expect(navLabels()).toEqual(['首页', '资料库', '复习', '学习统计', '待办', '零花钱', '设置']);
    expect(activeTab()?.textContent).toBe('首页');

    expect(button('开始复习')).toBeUndefined();
    await act(async () => button('添加回忆题')?.click());

    expect(window.location.search).toBe('?view=add');
    expect(activeTab()?.textContent).toBe('添加回忆题');
  });

  it('starts from Home once, but navigation and browser return show scope selection', async () => {
    const item = await repository.createTextItem({
      title: 'One-click test',
      itemType: 'Understand',
      coreLesson: 'Answer',
      recallPrompt: 'Remember?',
      referenceAnswer: 'Answer',
      fsrsCard: createEmptyCard(new Date()),
      tags: [],
    });
    const due = vi.spyOn(repository, 'listDueItems').mockResolvedValue([item]);
    vi.spyOn(repository, 'countDueReviewItems').mockResolvedValue(1);
    vi.spyOn(repository, 'listCategorySummaries').mockResolvedValue([]);
    try {
      await renderApp([item]);
      await act(async () => button('开始复习')?.click());
      expect(
        container.querySelector('.review-view')?.getAttribute('data-review-session-phase'),
      ).toBe('active');
      expect(container.textContent).toContain('Remember?');
      expect(due).toHaveBeenCalledTimes(1);
      await act(async () => button('首页')?.click());
      await act(async () => button('复习')?.click());
      expect(
        container.querySelector('.review-view')?.getAttribute('data-review-session-phase'),
      ).toBe('entry');
      await act(async () => button('首页')?.click());
      await act(async () => button('复习')?.click());
      expect(
        container.querySelector('.review-view')?.getAttribute('data-review-session-phase'),
      ).toBe('entry');
      await act(async () => {
        window.history.replaceState({}, '', '?view=home');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await act(async () => {
        window.history.replaceState({}, '', '?view=review');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      expect(
        container.querySelector('.review-view')?.getAttribute('data-review-session-phase'),
      ).toBe('entry');
    } finally {
      await repository.deleteItem(item.id);
    }
  });

  it('gives statistics its own primary entry and groups secondary navigation', async () => {
    await renderApp();
    await act(async () => button('查看学习统计')?.click());
    expect(window.location.search).toBe('?view=statistics');
    expect(activeTab()?.textContent).toBe('学习统计');
    expect(
      [...container.querySelectorAll('[aria-label="主导航"] button')].map(
        (node) => node.textContent,
      ),
    ).toEqual(['首页', '资料库', '复习', '学习统计']);
    expect(
      [...container.querySelectorAll('[aria-label="辅助导航"] button')].map(
        (node) => node.textContent,
      ),
    ).toEqual(['待办', '零花钱', '设置']);
    expect(navLabels()).toHaveLength(7);
    expect(container.querySelector('.dashboard-sidebar .brand-name')?.textContent).toBe(
      'ValRecall',
    );
  });

  it('opens legacy reading in manual mode and retains shared input across modes and navigation', async () => {
    const drafts = installDraftMemoryPort();
    window.history.replaceState({}, '', '/dashboard.html?view=reading');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderApp();
    expect(activeTab()?.textContent).toBe('添加回忆题');
    expect(button('手动创建')?.getAttribute('aria-pressed')).toBe('true');
    const excerpt = container.querySelector<HTMLTextAreaElement>('.manual-question-form textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        excerpt,
        '还在整理的阅读内容',
      );
      excerpt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('接收 ChatGPT 整理')?.click());
    expect(confirm).not.toHaveBeenCalled();
    await act(async () => button('首页')?.click());
    expect(window.location.search).toBe('?view=home');
    expect(confirm).not.toHaveBeenCalled();
    expect(
      [...drafts.values()].some((row) =>
        JSON.stringify(row.payload).includes('还在整理的阅读内容'),
      ),
    ).toBe(true);
    expect(container.querySelector('.add-window')?.hasAttribute('hidden')).toBe(true);
    await act(async () => button('添加回忆题')?.click());
    expect(window.location.search).toBe('?view=add');
    expect(button('手动创建')?.getAttribute('aria-pressed')).toBe('true');
    expect(
      container.querySelector<HTMLTextAreaElement>('.manual-question-form textarea')?.value,
    ).toBe('还在整理的阅读内容');
  });

  it('opens legacy intake and keeps its JSON input while switching and returning', async () => {
    installDraftMemoryPort();
    window.history.replaceState({}, '', '/dashboard.html?view=intake');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderApp();
    expect(activeTab()?.textContent).toBe('添加回忆题');
    const input = container.querySelector<HTMLTextAreaElement>('.intake-view textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        '尚未读取的手机整理内容',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('手动创建')?.click());
    await act(async () => button('接收 ChatGPT 整理')?.click());
    expect(input.value).toBe('尚未读取的手机整理内容');
    await act(async () => button('首页')?.click());
    expect(container.querySelector('.add-window')?.hasAttribute('hidden')).toBe(true);
    await act(async () => button('添加回忆题')?.click());
    expect(window.location.search).toBe('?view=add');
    expect(container.querySelector<HTMLTextAreaElement>('.intake-view textarea')?.value).toBe(
      '尚未读取的手机整理内容',
    );
  });

  it('creates through the shared workspace and opens the saved read-only Library detail', async () => {
    const title = 'A54 integration question';
    await renderApp();
    await act(async () => button('添加回忆题')!.click());
    await act(async () => button('手动创建')!.click());
    const form = container.querySelector<HTMLFormElement>('.manual-question-form form')!;
    const fill = (label: string, value: string) => {
      const control = [...form.querySelectorAll('label')]
        .find((node) => node.querySelector('span')?.textContent === label)!
        .querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea')!;
      const prototype =
        control instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value);
      control.dispatchEvent(new Event('input', { bubbles: true }));
    };
    act(() => {
      fill('标题', title);
      fill('回忆问题', '合上书以后如何检验理解？');
      fill('答案要点', '独立解释，再核对来源。');
    });
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    let created: LearningItem | undefined;
    try {
      await settleUntil(async () => {
        created = (await repository.listItems()).find(
          (item) => item.sourceType === 'text' && item.title === title,
        );
        expect(created).toBeDefined();
        expect(container.textContent).toContain('回忆题已保存');
      });
      await act(async () => button('在资料库查看')!.click());
      await settleUntil(() => {
        expect(window.location.search).toBe('?view=library');
        expect(container.querySelector('.library-reading')?.textContent).toContain(
          '独立解释，再核对来源。',
        );
      });
      expect(container.querySelector('.detail-editor')).toBeNull();
      expect(document.activeElement).toBe(container.querySelector('.library-detail-heading h3'));
    } finally {
      const saved = created;
      if (saved)
        await act(async () => {
          await repository.deleteItem(saved.id);
        });
    }
  }, 30_000);

  it('opens the pocket-money ledger from the secondary 零花钱 entry', async () => {
    await renderApp();
    await act(async () => {
      button('零花钱')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(window.location.search).toBe('?view=allowance');
    expect(activeTab()?.textContent).toBe('零花钱');
    expect(container.textContent).toContain('零花钱记录');
  });

  it('opens an explicit saved item and retains Library filters and directory position on return', async () => {
    const item = await repository.createTextItem({
      title: 'Preserved directory item',
      itemType: 'Understand',
      coreLesson: 'Stored answer',
      recallPrompt: 'Stored question',
      referenceAnswer: 'Stored answer',
      fsrsCard: createEmptyCard(new Date()),
      tags: [],
    });
    window.history.replaceState(
      {},
      '',
      `/dashboard.html?view=library&item=${encodeURIComponent(item.id)}`,
    );
    try {
      await renderApp();
      await settleUntil(() => {
        expect(container.querySelector('.library-detail-heading h3')?.textContent).toBe(
          'Preserved directory item',
        );
      });
      const search = container.querySelector<HTMLInputElement>('[aria-label="搜索回忆题"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          search,
          'Preserved',
        );
        search.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const directory = container.querySelector<HTMLElement>('.library-results')!;
      directory.scrollTop = 350;
      await act(async () => button('首页')?.click());
      expect(window.location.search).toBe('?view=home');
      expect(container.querySelector('.library-window')?.hasAttribute('hidden')).toBe(true);
      await act(async () => button('资料库')?.click());
      expect(search.value).toBe('Preserved');
      expect(container.querySelector('.library-results')).toBe(directory);
      expect(directory.scrollTop).toBe(350);
      expect(container.querySelector('.library-detail-heading h3')?.textContent).toBe(
        'Preserved directory item',
      );
    } finally {
      await repository.deleteItem(item.id);
    }
  }, 30_000);

  it('opens the cohort forecast inside Review sub-navigation without adding a top-level tab', async () => {
    await renderApp();

    await act(async () => {
      button('查看完整日程')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(window.location.search).toBe('?view=review');
    expect(container.textContent).toContain('即将到期');
    expect(button('现在到期')?.getAttribute('aria-selected')).toBe('false');
    expect(button('即将到期')?.getAttribute('aria-selected')).toBe('true');
    expect(navLabels()).toEqual(['首页', '资料库', '复习', '学习统计', '待办', '零花钱', '设置']);
    expect(document.activeElement?.textContent).toContain('即将到期');

    await act(async () => {
      button('现在到期')?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('到期主动回忆');
    expect(button('现在到期')?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement?.textContent).toContain('到期主动回忆');
  });

  it('keeps Back and the visible route aligned when the current tab is clicked during draft persistence', async () => {
    installDraftMemoryPort();
    const original = vi.mocked(DraftRepository.prototype.save).getMockImplementation()!;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = vi
      .spyOn(DraftRepository.prototype, 'save')
      .mockImplementationOnce(async (input, revision) => {
        await gate;
        return original(input, revision);
      });
    await renderApp();
    await act(async () => button('待办')?.click());
    await settleUntil(() => {
      expect(button('添加待办')).toBeTruthy();
    });
    await act(async () => button('添加待办')?.click());
    const input = container.querySelector<HTMLInputElement>('.task-form input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        '最后一行待办',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(save).toHaveBeenCalledOnce();
    expect(activeTab()?.textContent).toBe('待办');
    await act(async () => button('待办')?.click());
    await act(async () => {
      release?.();
      await gate;
    });
    expect(window.location.search).toBe('?view=home');
    expect(activeTab()?.textContent).toBe('首页');
  }, 30_000);

  it('honours an addressable query view and reacts to browser history', async () => {
    window.history.replaceState({}, '', '/dashboard.html?view=settings');
    await renderApp();
    expect(container.textContent).toContain('捕获与复习偏好');

    window.history.pushState({}, '', '/dashboard.html?view=home');
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
      await Promise.resolve();
    });

    expect(container.textContent).toContain('今天的学习');
    expect(activeTab()?.textContent).toBe('首页');
    expect(document.activeElement?.textContent).toContain('今天的学习');
  });

  it('updates a route immediately without animating or blanking the shell', async () => {
    const startViewTransition = vi.fn((update: () => void) => {
      update();
      return {
        finished: Promise.resolve(),
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        skipTransition: vi.fn(),
      };
    });
    Object.assign(document, { startViewTransition });
    await renderApp();

    await act(async () => button('设置')?.click());

    expect(startViewTransition).not.toHaveBeenCalled();
    expect(container.querySelector('header')).not.toBeNull();
    expect(container.querySelector('.dashboard-route-content')).not.toBeNull();
    expect(container.textContent).toContain('捕获与复习偏好');
    expect(document.activeElement?.textContent).toContain('捕获与复习偏好');
  });

  it('updates routes immediately without View Transitions when reduced motion is requested', async () => {
    const startViewTransition = vi.fn();
    Object.assign(document, { startViewTransition });
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
    await renderApp();

    await act(async () => button('设置')?.click());

    expect(startViewTransition).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?view=settings');
    expect(container.textContent).toContain('捕获与复习偏好');
  });

  it('repairs an unsupported addressable view to the stable Home route', async () => {
    window.history.replaceState({}, '', '/dashboard.html?view=unknown');
    await renderApp();

    expect(window.location.search).toBe('?view=home');
    expect(activeTab()?.textContent).toBe('首页');
    expect(container.textContent).toContain('今天的学习');
  });

  it('keeps Backup and recovery directly reachable from Settings', async () => {
    window.history.replaceState({}, '', '/dashboard.html?view=settings');
    await renderApp();

    await act(async () => button('备份与恢复')?.click());

    expect(window.location.search).toBe('?view=data');
    expect(container.textContent).toContain('备份与恢复');
    expect(navLabels()).toEqual(['首页', '资料库', '复习', '学习统计', '待办', '零花钱', '设置']);
    expect(activeTab()?.textContent).toBe('设置');

    await act(async () => button('返回设置')?.click());
    expect(window.location.search).toBe('?view=settings');
  });

  async function renderApp(items: LearningItem[] = []) {
    const preferenceLoader = async () => DEFAULT_PREFERENCES;
    const homeItemsLoader = async () => items;
    const homeTaskSummaryLoader = async (localDate: string) => ({
      localDate,
      total: 0,
      completed: 0,
      remaining: 0,
      occurrences: [],
    });
    await act(async () => {
      root.render(
        <DashboardApp
          preferenceLoader={preferenceLoader}
          homeItemsLoader={homeItemsLoader}
          homeTaskSummaryLoader={homeTaskSummaryLoader}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function button(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === label,
    );
  }

  function navLabels(): Array<string | null> {
    return [...container.querySelectorAll('.nav-tab')].map((tab) => tab.textContent);
  }

  function activeTab(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>('.dashboard-sidebar [aria-current="page"]');
  }
});
