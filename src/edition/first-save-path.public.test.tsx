import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DashboardApp } from '../dashboard/DashboardApp';
import { repository } from '../dashboard/services';
import { FsrsService } from '../fsrs';
import { DEFAULT_PREFERENCES } from '../shared/preferences';

// Set before any import, because HomeView and DashboardApp read the flag once on load.
vi.hoisted(() => Object.assign(globalThis, { __VALRECALL_PUBLIC_RELEASE__: true }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SAVED_ONCE_KEY = 'valrecall.savedItemOnce';

describe('saved and then deleted is not a new user, public edition', () => {
  let container: HTMLDivElement;
  let root: Root;
  let stored: Record<string, unknown>;

  async function waitFor(check: () => void) {
    for (let attempt = 0; ; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      try {
        check();
        return;
      } catch (error) {
        if (attempt >= 150) throw error;
      }
    }
  }

  const button = (label: string) =>
    Array.from(container.querySelectorAll('button')).find(
      (entry) => entry.textContent?.trim() === label && !entry.closest('[hidden]'),
    )!;

  function type(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
    act(() => {
      const prototype =
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  beforeEach(async () => {
    await repository.clearAllData();
    const transaction = (await repository.open()).transaction('learningReceipts', 'readwrite');
    transaction.objectStore('learningReceipts').clear();
    stored = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => (key in stored ? { [key]: stored[key] } : {})),
          set: vi.fn(async (values: Record<string, unknown>) => Object.assign(stored, values)),
        },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      commands: {
        getAll: vi
          .fn()
          .mockResolvedValue([{ name: 'capture-learning-moment', shortcut: 'Ctrl+Shift+Y' }]),
      },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    window.history.replaceState({}, '', '/dashboard.html');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root.render(<DashboardApp preferenceLoader={async () => DEFAULT_PREFERENCES} />),
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function expectHomeNotNew() {
    await act(async () => button('首页').click());
    await waitFor(() => expect(container.textContent).toContain('今天都跟上进度了。'));
    expect(container.querySelector('.first-run-card')).toBeNull();
    expect(container.textContent).not.toContain('还没有内容。先存一条吧。');
  }

  it('Home, Add, save, Library, delete, Home', async () => {
    await waitFor(() => expect(container.querySelector('.first-run-card')).not.toBeNull());

    await act(async () =>
      container.querySelector<HTMLButtonElement>('.dashboard-add-action')!.click(),
    );
    await waitFor(() => expect(window.location.search).toBe('?view=add'));
    await waitFor(() =>
      expect(container.querySelector('.manual-question-panel input')).not.toBeNull(),
    );
    expect(container.querySelector('.first-run-card')).toBeNull();
    const panel = container.querySelector<HTMLElement>('.manual-question-panel')!;
    type(panel.querySelector('input')!, '一道题');
    const [prompt, answer] = Array.from(panel.querySelectorAll('textarea'));
    type(prompt!, '为什么？');
    type(answer!, '因为这样。');
    await act(async () => button('保存回忆题').click());
    await waitFor(() => expect(container.textContent).toContain('回忆题已保存'));
    const [saved] = await repository.listRecentItems(1);
    expect(saved).toBeDefined();

    await act(async () => button('在资料库查看').click());
    await waitFor(() => expect(window.location.search).toContain('view=library'));
    await waitFor(() => expect(button('删除回忆题')).toBeDefined());
    await act(async () => button('删除回忆题').click());
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    for (let attempt = 0; (await repository.listRecentItems(1)).length > 0; attempt += 1) {
      if (attempt > 50) throw new Error('The item was not deleted.');
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }

    // No mounted page saw the item, so nothing remembered it: only the save itself can tell.
    expect(stored[SAVED_ONCE_KEY]).toBeUndefined();
    await expectHomeNotNew();
  });

  it('a capture from the side panel, deleted before Home ever saw it', async () => {
    await act(async () => button('资料库').click());
    await waitFor(() => expect(window.location.search).toContain('view=library'));
    await repository.createItem(
      {
        id: 'captured',
        itemType: 'Understand',
        platform: 'bilibili',
        videoTitle: '一段视频',
        sourceUrl: 'https://www.bilibili.com/video/BV1test',
        timestampSeconds: 12,
        timestampDisplay: '00:12',
        coreLesson: '因为这样。',
        recallPrompt: '为什么？',
        referenceAnswer: '因为这样。',
        tags: [],
        fsrsCard: new FsrsService().createInitialCard(),
      },
      new Blob(['x'], { type: 'image/png' }),
      { id: 'captured', kind: 'capture', fingerprint: 'same' },
    );
    await repository.deleteItem('captured');
    expect(stored[SAVED_ONCE_KEY]).toBeUndefined();
    await expectHomeNotNew();
  });

  it('delete-all does not bring the first-run card back', async () => {
    await act(async () => button('资料库').click());
    await waitFor(() => expect(window.location.search).toContain('view=library'));
    await repository.createTextItem(
      {
        id: 'added',
        title: '一道题',
        itemType: 'Understand',
        recallPrompt: '为什么？',
        coreLesson: '因为这样。',
        referenceAnswer: '因为这样。',
        tags: [],
        fsrsCard: new FsrsService().createInitialCard(),
      },
      { id: 'added', kind: 'manual', fingerprint: 'same' },
    );
    await repository.clearAllData();
    await expectHomeNotNew();
  });

  it('someone who saved nothing still gets the card', async () => {
    await waitFor(() => expect(container.querySelector('.first-run-card')).not.toBeNull());
    expect(container.textContent).toContain('还没有内容。先存一条吧。');
  });
});
