import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CompanionWardrobeProvider } from '../companion/CompanionWardrobe';
import {
  COMPANION_FIGURE_POSES,
  COMPANION_HEAD_POSES,
  COMPANION_OUTFIT_LABELS,
  COMPANION_OUTFITS,
  outfitForDate,
  type CompanionOutfit,
} from '../companion/wardrobe';
import { COMPANION_WARDROBE_STORAGE_KEY } from '../companion/wardrobe-preference';
import { DEFAULT_PREFERENCES } from '../shared/preferences';
import { DashboardApp } from './DashboardApp';
import { WardrobeView } from './WardrobeView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 9, 28, 14, 0);
const TODAY = '2026-10-28';
const clock = () => new Date(NOW);

function fakeChrome(stored: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { ...stored };
  const set = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(values, items);
  });
  return {
    values,
    set,
    api: {
      storage: {
        local: {
          get: vi.fn(async (key: string) => (key in values ? { [key]: values[key] } : {})),
          set,
        },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    },
  };
}

function reducedMotionMedia(matches: boolean) {
  return vi.fn((media: string) => ({
    matches: matches && media === '(prefers-reduced-motion: reduce)',
    media,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe('WardrobeView', () => {
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

  async function renderWardrobe(stored: Record<string, unknown> = {}) {
    const chrome = fakeChrome(stored);
    vi.stubGlobal('chrome', chrome.api);
    const onBack = vi.fn();
    await act(async () => {
      root.render(
        <CompanionWardrobeProvider>
          <WardrobeView onBackToSettings={onBack} clock={clock} />
        </CompanionWardrobeProvider>,
      );
    });
    return { chrome, onBack };
  }

  function cards(): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('.wardrobe-card')];
  }

  function card(outfit: CompanionOutfit): HTMLElement {
    return container.querySelector<HTMLElement>(`[data-wardrobe-outfit="${outfit}"]`)!;
  }

  function badges(outfit: CompanionOutfit): string[] {
    return [...card(outfit).querySelectorAll('.wardrobe-badge')].map(
      (badge) => badge.textContent ?? '',
    );
  }

  function button(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === label,
    );
  }

  function modeRadio(mode: 'daily' | 'pinned'): HTMLInputElement {
    return container.querySelector<HTMLInputElement>(
      `input[name="wardrobe-mode"][value="${mode}"]`,
    )!;
  }

  function detailSources(): string[] {
    return [...container.querySelectorAll('.wardrobe-detail img')].map(
      (image) => image.getAttribute('src') ?? '',
    );
  }

  it('lists the twelve outfits in rotation order with their labels and calm still art', async () => {
    await renderWardrobe();

    expect(cards().map((entry) => entry.dataset.wardrobeOutfit)).toEqual([...COMPANION_OUTFITS]);
    expect(
      cards().map((entry) => entry.querySelector('.wardrobe-card-label')?.textContent),
    ).toEqual(COMPANION_OUTFITS.map((outfit) => COMPANION_OUTFIT_LABELS[outfit]));
    for (const outfit of COMPANION_OUTFITS) {
      const image = card(outfit).querySelector('img')!;
      expect(image.getAttribute('src')).toBe(`assets/companion/chibi/${outfit}/calm.svg`);
      expect(image.getAttribute('alt')).toBe('');
    }
    const radios = container.querySelectorAll<HTMLInputElement>('input[name="wardrobe-outfit"]');
    expect(radios).toHaveLength(12);
    expect(container.querySelector('.wardrobe-outfits legend')?.textContent).toBe('全部穿搭');
    expect(container.textContent).toContain('手机和小组件仍每天换一套。');
  });

  it("badges today's outfit by date and opens on it in the daily mode", async () => {
    await renderWardrobe();
    const today = outfitForDate(TODAY);
    expect(today).toBe('outfit7');

    expect(modeRadio('daily').checked).toBe(true);
    expect(modeRadio('pinned').checked).toBe(false);
    expect(badges(today)).toEqual(['今天']);
    for (const outfit of COMPANION_OUTFITS.filter((entry) => entry !== today)) {
      expect(badges(outfit)).toEqual([]);
    }
    expect(card(today).classList.contains('is-selected')).toBe(true);
    expect(container.querySelector('#wardrobe-detail-heading')?.textContent).toBe('服装 7');
    expect(button('改回每天换')).toBeUndefined();
  });

  it('shows all 22 poses of the chosen card, animated, with labels and lazy lower rows', async () => {
    const { chrome } = await renderWardrobe();

    const radio = card('outfit12').querySelector<HTMLInputElement>('input')!;
    await act(async () => radio.click());

    expect(
      container.querySelector('[data-wardrobe-detail]')?.getAttribute('data-wardrobe-detail'),
    ).toBe('outfit12');
    const poses = [...COMPANION_FIGURE_POSES, ...COMPANION_HEAD_POSES];
    const items = [...container.querySelectorAll<HTMLElement>('.wardrobe-pose')];
    expect(items.map((item) => item.dataset.wardrobePose)).toEqual(poses);
    expect(items.every((item) => item.querySelector('.wardrobe-pose-label')?.textContent)).toBe(
      true,
    );
    expect(detailSources()).toEqual(
      poses.map((pose) =>
        pose === 'head-worried'
          ? 'assets/companion/chibi/outfit12/head-worried.svg'
          : `assets/companion/chibi/outfit12/${pose}.anim.svg`,
      ),
    );
    const images = [...container.querySelectorAll('.wardrobe-detail img')];
    expect(images.every((image) => image.getAttribute('alt') === '')).toBe(true);
    expect(images.slice(0, 6).every((image) => image.getAttribute('loading') === 'eager')).toBe(
      true,
    );
    expect(images.slice(6).every((image) => image.getAttribute('loading') === 'lazy')).toBe(true);
    // Viewing a card saves nothing.
    expect(chrome.set).not.toHaveBeenCalled();
  });

  it('pins the chosen outfit and returns to the daily rotation, saving each change at once', async () => {
    const { chrome } = await renderWardrobe();

    await act(async () => card('outfit10').querySelector<HTMLInputElement>('input')!.click());
    await act(async () => button('固定这套')!.click());

    expect(chrome.set).toHaveBeenLastCalledWith({
      [COMPANION_WARDROBE_STORAGE_KEY]: { version: 1, mode: 'pinned', outfit: 'outfit10' },
    });
    expect(modeRadio('pinned').checked).toBe(true);
    expect(badges('outfit10')).toEqual(['已固定']);
    expect(badges('outfit7')).toEqual(['今天']);
    expect(button('固定这套')).toBeUndefined();
    expect(container.querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe(
      '已固定：服装 10。',
    );

    await act(async () => button('改回每天换')!.click());

    expect(chrome.set).toHaveBeenLastCalledWith({
      [COMPANION_WARDROBE_STORAGE_KEY]: { version: 1, mode: 'daily' },
    });
    expect(modeRadio('daily').checked).toBe(true);
    expect(badges('outfit10')).toEqual([]);
    expect(container.querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe(
      '已改回每天换一套。',
    );
    expect(chrome.set).toHaveBeenCalledTimes(2);
  });

  it('pins the shown outfit from the mode choice and opens on a stored pin', async () => {
    const { chrome } = await renderWardrobe({
      [COMPANION_WARDROBE_STORAGE_KEY]: { version: 1, mode: 'pinned', outfit: 'outfit8' },
    });

    expect(modeRadio('pinned').checked).toBe(true);
    expect(card('outfit8').classList.contains('is-selected')).toBe(true);
    expect(badges('outfit8')).toEqual(['已固定']);

    await act(async () => modeRadio('daily').click());
    expect(chrome.set).toHaveBeenLastCalledWith({
      [COMPANION_WARDROBE_STORAGE_KEY]: { version: 1, mode: 'daily' },
    });

    await act(async () => card('outfit9').querySelector<HTMLInputElement>('input')!.click());
    await act(async () => modeRadio('pinned').click());
    expect(chrome.set).toHaveBeenLastCalledWith({
      [COMPANION_WARDROBE_STORAGE_KEY]: { version: 1, mode: 'pinned', outfit: 'outfit9' },
    });
    expect(badges('outfit9')).toEqual(['已固定']);
  });

  it('shows only still files under reduced motion', async () => {
    vi.stubGlobal('matchMedia', reducedMotionMedia(true));
    await renderWardrobe();

    const sources = [...container.querySelectorAll('img')].map(
      (image) => image.getAttribute('src') ?? '',
    );
    expect(sources.length).toBe(12 + 22);
    expect(sources.some((source) => source.endsWith('.anim.svg'))).toBe(false);
    expect(
      [...container.querySelectorAll('.wardrobe-detail img')].every(
        (image) => image.getAttribute('data-companion-motion') === 'static',
      ),
    ).toBe(true);
  });

  it('keeps the choice and shows the worried notice when a save fails', async () => {
    const { chrome } = await renderWardrobe();
    chrome.set.mockRejectedValueOnce(new Error('quota'));

    await act(async () => button('固定这套')!.click());

    const notice = container.querySelector('.notice.error');
    expect(notice?.getAttribute('role')).toBe('alert');
    expect(notice?.textContent).toContain('保存失败，请重试。');
    expect(notice?.querySelector('img')?.getAttribute('src')).toBe(
      'assets/companion/chibi/outfit7/head-worried.svg',
    );
    expect(modeRadio('daily').checked).toBe(true);
    expect(badges('outfit7')).toEqual(['今天']);

    await act(async () => button('固定这套')!.click());
    expect(container.querySelector('.notice.error')).toBeNull();
    expect(badges('outfit7')).toEqual(['今天', '已固定']);
  });

  it('goes back to Settings', async () => {
    const { onBack } = await renderWardrobe();
    await act(async () => button('返回设置')!.click());
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(container.querySelector('h2.dashboard-page-heading')?.textContent).toBe('衣橱');
  });

  it('keeps its stylesheet free of keyframes and endless loops', () => {
    const css = readFileSync(resolve('src/dashboard/wardrobe.css'), 'utf8');
    expect(css).not.toMatch(/@keyframes|\binfinite\b/u);
    expect(css).toContain(':focus-visible');
  });
});

describe('DashboardApp wardrobe route', () => {
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function renderApp() {
    await act(async () => {
      root.render(
        <DashboardApp
          preferenceLoader={async () => DEFAULT_PREFERENCES}
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
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function button(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === label,
    );
  }

  function activeTab(): string | null | undefined {
    return container.querySelector('.dashboard-sidebar [aria-current="page"]')?.textContent;
  }

  async function waitForWardrobe() {
    await vi.waitFor(async () => {
      await act(async () => Promise.resolve());
      expect(container.querySelector('.wardrobe-view')).not.toBeNull();
    });
  }

  it('opens the wardrobe lazily from Settings, focuses it and returns', async () => {
    window.history.replaceState({}, '', '/dashboard.html?view=settings');
    await renderApp();

    await act(async () => button('衣橱')!.click());
    await waitForWardrobe();

    expect(window.location.search).toBe('?view=wardrobe');
    expect(activeTab()).toBe('设置');
    expect(document.activeElement?.textContent).toBe('衣橱');
    expect(container.querySelectorAll('.wardrobe-card')).toHaveLength(12);

    await act(async () => button('返回设置')!.click());
    expect(window.location.search).toBe('?view=settings');
    expect(container.textContent).toContain('捕获与复习偏好');
  });

  it('honours ?view=wardrobe as a direct address', async () => {
    window.history.replaceState({}, '', '/dashboard.html?view=wardrobe');
    await renderApp();
    await waitForWardrobe();

    expect(window.location.search).toBe('?view=wardrobe');
    expect(activeTab()).toBe('设置');
  });
});
