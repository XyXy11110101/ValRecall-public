import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Companion } from '../dashboard/Companion';
import {
  CompanionWardrobeProvider,
  useCompanionWardrobe,
  type CompanionWardrobeValue,
} from './CompanionWardrobe';
import { outfitForDate } from './wardrobe';
import { COMPANION_WARDROBE_STORAGE_KEY } from './wardrobe-preference';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ChangeListener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;

function fakeChrome(stored: Record<string, unknown> = {}) {
  const listeners = new Set<ChangeListener>();
  let resolveGet: (() => void) | null = null;
  const values: Record<string, unknown> = { ...stored };
  const api = {
    storage: {
      local: {
        get: vi.fn(
          (key: string) =>
            new Promise<Record<string, unknown>>((resolve) => {
              resolveGet = () => resolve(key in values ? { [key]: values[key] } : {});
            }),
        ),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(values, items);
        }),
      },
      onChanged: {
        addListener: vi.fn((listener: ChangeListener) => listeners.add(listener)),
        removeListener: vi.fn((listener: ChangeListener) => listeners.delete(listener)),
      },
    },
  };
  return {
    api,
    values,
    listeners,
    finishLoad: () => resolveGet?.(),
    emit: (newValue: unknown, area = 'local') => {
      for (const listener of listeners) {
        listener({ [COMPANION_WARDROBE_STORAGE_KEY]: { newValue } }, area);
      }
    },
  };
}

describe('CompanionWardrobeProvider', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: CompanionWardrobeValue | null;

  function Probe() {
    const wardrobe = useCompanionWardrobe();
    useEffect(() => {
      latest = wardrobe;
    });
    return <span data-ready={wardrobe.ready} data-outfit={wardrobe.outfitFor('2026-10-28')} />;
  }

  beforeEach(() => {
    latest = null;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('wears the daily outfit at once without a provider', () => {
    act(() => root.render(<Probe />));
    expect(latest?.ready).toBe(true);
    expect(latest?.preference).toEqual({ version: 1, mode: 'daily' });
    expect(latest?.outfitFor('2026-10-28')).toBe(outfitForDate('2026-10-28'));
  });

  it('keeps companions on their placeholder until a pinned outfit is read', async () => {
    const chrome = fakeChrome({
      [COMPANION_WARDROBE_STORAGE_KEY]: { version: 1, mode: 'pinned', outfit: 'outfit10' },
    });
    vi.stubGlobal('chrome', chrome.api);
    act(() =>
      root.render(
        <CompanionWardrobeProvider>
          <Probe />
          <Companion state="idle" pose="calm" dateKey="2026-10-28" message={null} />
        </CompanionWardrobeProvider>,
      ),
    );

    expect(latest?.ready).toBe(false);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.companion-abstract')).not.toBeNull();

    await act(async () => chrome.finishLoad());

    expect(latest?.ready).toBe(true);
    expect(latest?.preference).toEqual({ version: 1, mode: 'pinned', outfit: 'outfit10' });
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'assets/companion/chibi/outfit10/calm.anim.svg',
    );
    expect(container.querySelector('.companion')?.getAttribute('data-companion-outfit')).toBe(
      'outfit10',
    );
  });

  it('follows changes from other pages and ignores other keys and areas', async () => {
    const chrome = fakeChrome();
    vi.stubGlobal('chrome', chrome.api);
    act(() =>
      root.render(
        <CompanionWardrobeProvider>
          <Probe />
        </CompanionWardrobeProvider>,
      ),
    );
    await act(async () => chrome.finishLoad());
    expect(latest?.outfitFor('2026-10-28')).toBe(outfitForDate('2026-10-28'));

    act(() => chrome.emit({ version: 1, mode: 'pinned', outfit: 'outfit12' }, 'sync'));
    expect(latest?.preference.mode).toBe('daily');

    act(() => {
      for (const listener of chrome.listeners) {
        listener({ 'valrecall.preferences': { newValue: {} } }, 'local');
      }
    });
    expect(latest?.preference.mode).toBe('daily');

    act(() => chrome.emit({ version: 1, mode: 'pinned', outfit: 'outfit12' }));
    expect(latest?.preference).toEqual({ version: 1, mode: 'pinned', outfit: 'outfit12' });
    expect(latest?.outfitFor('2026-10-29')).toBe('outfit12');

    act(() => chrome.emit(undefined));
    expect(latest?.preference).toEqual({ version: 1, mode: 'daily' });
  });

  it('saves a normalized choice and applies it at once', async () => {
    const chrome = fakeChrome();
    vi.stubGlobal('chrome', chrome.api);
    act(() =>
      root.render(
        <CompanionWardrobeProvider>
          <Probe />
        </CompanionWardrobeProvider>,
      ),
    );
    await act(async () => chrome.finishLoad());

    await act(async () => latest?.save({ version: 1, mode: 'pinned', outfit: 'outfit8' }));

    expect(chrome.api.storage.local.set).toHaveBeenCalledWith({
      [COMPANION_WARDROBE_STORAGE_KEY]: { version: 1, mode: 'pinned', outfit: 'outfit8' },
    });
    expect(latest?.preference).toEqual({ version: 1, mode: 'pinned', outfit: 'outfit8' });
    expect(container.querySelector('span')?.getAttribute('data-outfit')).toBe('outfit8');
  });

  it('lets a save made before the first read win over that read', async () => {
    const chrome = fakeChrome({
      [COMPANION_WARDROBE_STORAGE_KEY]: { version: 1, mode: 'pinned', outfit: 'outfit1' },
    });
    vi.stubGlobal('chrome', chrome.api);
    act(() =>
      root.render(
        <CompanionWardrobeProvider>
          <Probe />
        </CompanionWardrobeProvider>,
      ),
    );
    await act(async () => latest?.save({ version: 1, mode: 'pinned', outfit: 'outfit9' }));
    await act(async () => chrome.finishLoad());
    expect(latest?.preference).toEqual({ version: 1, mode: 'pinned', outfit: 'outfit9' });
  });

  it('becomes ready on the daily rotation when the stored choice cannot be read', async () => {
    const chrome = fakeChrome();
    chrome.api.storage.local.get.mockRejectedValueOnce(new Error('storage unavailable'));
    vi.stubGlobal('chrome', chrome.api);
    act(() =>
      root.render(
        <CompanionWardrobeProvider>
          <Probe />
        </CompanionWardrobeProvider>,
      ),
    );
    await act(async () => Promise.resolve());
    expect(latest?.ready).toBe(true);
    expect(latest?.preference).toEqual({ version: 1, mode: 'daily' });
  });

  it('is daily and ready outside the extension, and removes its listener on unmount', async () => {
    const chrome = fakeChrome();
    vi.stubGlobal('chrome', chrome.api);
    act(() =>
      root.render(
        <CompanionWardrobeProvider>
          <Probe />
        </CompanionWardrobeProvider>,
      ),
    );
    expect(chrome.listeners.size).toBe(1);
    act(() => root.render(<></>));
    expect(chrome.listeners.size).toBe(0);

    vi.stubGlobal('chrome', undefined);
    act(() =>
      root.render(
        <CompanionWardrobeProvider>
          <Probe />
        </CompanionWardrobeProvider>,
      ),
    );
    await act(async () => Promise.resolve());
    expect(latest?.ready).toBe(true);
    expect(latest?.preference).toEqual({ version: 1, mode: 'daily' });
  });
});
