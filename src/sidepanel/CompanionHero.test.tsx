import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CompanionWardrobeProvider } from '../companion/CompanionWardrobe';
import { headPoseForMood } from '../companion/companion-scenes';
import { companionArtPath, outfitForDate } from '../companion/wardrobe';
import { COMPANION_WARDROBE_STORAGE_KEY } from '../companion/wardrobe-preference';
import {
  CompanionHero,
  type CompanionHeroState,
  resolveCompanionHeroState,
  useTemporaryCompanionSuccess,
} from './CompanionHero';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('CompanionHero', () => {
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
    vi.unstubAllGlobals();
  });

  it.each<CompanionHeroState>(['idle', 'due', 'reviewing', 'success'])(
    'shows the %s expression in today’s outfit with decorative semantics',
    (state) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 9, 28, 14, 0));
      act(() => root.render(<CompanionHero state={state} status="State" detail="Detail" />));

      const hero = container.querySelector<HTMLElement>('.companion-hero');
      const image = container.querySelector<HTMLImageElement>('img');
      expect(hero?.dataset.companionHeroState).toBe(state);
      expect(image?.getAttribute('src')).toBe(
        companionArtPath(outfitForDate('2026-10-28'), headPoseForMood(state), 'animated'),
      );
      expect(image?.getAttribute('data-companion-pose')).toBe(headPoseForMood(state));
      expect(image?.getAttribute('alt')).toBe('');
      expect(image?.getAttribute('aria-hidden')).toBe('true');
      expect(image?.draggable).toBe(false);
      expect(container.querySelectorAll('img')).toHaveLength(1);
    },
  );

  it('keeps the head still under reduced motion', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    act(() => root.render(<CompanionHero state="due" status="State" detail="Detail" />));
    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).not.toContain('.anim.');
    expect(image?.getAttribute('src')).toMatch(/\/head-talk\.svg$/);
    expect(image?.getAttribute('data-companion-motion')).toBe('static');
  });

  it('changes outfit when the panel is shown again on a later day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 28, 23, 50));
    act(() => root.render(<CompanionHero state="idle" status="State" detail="Detail" />));
    const before = container.querySelector('img')?.getAttribute('data-companion-outfit');
    expect(before).toBe(outfitForDate('2026-10-28'));

    vi.setSystemTime(new Date(2026, 9, 29, 8, 0));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(container.querySelector('img')?.getAttribute('data-companion-outfit')).toBe(
      outfitForDate('2026-10-29'),
    );
  });

  it('waits for the wardrobe and then wears the pinned outfit', async () => {
    let finish!: () => void;
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: () =>
            new Promise((resolve) => {
              finish = () =>
                resolve({
                  [COMPANION_WARDROBE_STORAGE_KEY]: {
                    version: 1,
                    mode: 'pinned',
                    outfit: 'outfit8',
                  },
                });
            }),
          set: vi.fn(),
        },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });
    act(() =>
      root.render(
        <CompanionWardrobeProvider>
          <CompanionHero state="success" status="Saved" detail="Done" />
        </CompanionWardrobeProvider>,
      ),
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.companion-hero-abstract')).not.toBeNull();
    await act(async () => finish());
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'assets/companion/chibi/outfit8/head-joy.anim.svg',
    );
  });

  it('keeps status text readable while a private image is loading', () => {
    act(() =>
      root.render(
        <CompanionHero
          state="reviewing"
          status="An unusually long platform label · 01:23"
          detail="Review the captured moment, then save it to your queue."
        />,
      ),
    );

    expect(container.textContent).toContain('An unusually long platform label · 01:23');
    expect(container.querySelector('img')?.dataset.assetStatus).toBe('loading');
  });

  it('shows a restrained working indicator only for genuine processing', () => {
    act(() =>
      root.render(
        <CompanionHero
          state="reviewing"
          status="Capturing moment"
          detail="Preparing context."
          working
        />,
      ),
    );

    expect(container.querySelector('.motion-loading-indicator')).not.toBeNull();
    expect(container.textContent).toContain('处理中');

    act(() =>
      root.render(<CompanionHero state="idle" status="Ready" detail="Capture a moment." />),
    );
    expect(container.querySelector('.motion-loading-indicator')).toBeNull();
  });

  it('fails safely to the abstract treatment when a private asset is missing', () => {
    act(() => root.render(<CompanionHero state="success" status="Saved" detail="Done" />));
    const image = container.querySelector('img');

    act(() => image?.dispatchEvent(new Event('error')));

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.companion-hero-abstract')).not.toBeNull();
    expect(container.textContent).toContain('Saved');
  });

  it('returns from temporary success to the persistent due state', () => {
    vi.useFakeTimers();

    function Harness() {
      const [success, triggerSuccess] = useTemporaryCompanionSuccess(1000);
      const state = resolveCompanionHeroState({ temporarySuccess: success, dueCount: 2 });
      return (
        <button data-state={state} onClick={triggerSuccess}>
          Trigger
        </button>
      );
    }

    act(() => root.render(<Harness />));
    const button = container.querySelector('button');
    expect(button?.dataset.state).toBe('due');

    act(() => button?.click());
    expect(button?.dataset.state).toBe('success');

    act(() => vi.advanceTimersByTime(999));
    expect(button?.dataset.state).toBe('success');
    act(() => vi.advanceTimersByTime(1));
    expect(button?.dataset.state).toBe('due');
  });

  it('returns from temporary success to idle and cleans the finite timer on unmount', () => {
    vi.useFakeTimers();

    function SuccessChild() {
      const [success, triggerSuccess] = useTemporaryCompanionSuccess(1000);
      return (
        <button data-state={success ? 'success' : 'idle'} onClick={triggerSuccess}>
          Trigger
        </button>
      );
    }

    function Harness() {
      const [visible, setVisible] = useState(true);
      return (
        <>
          <button onClick={() => setVisible(false)}>Unmount child</button>
          {visible && <SuccessChild />}
        </>
      );
    }

    act(() => root.render(<Harness />));
    const buttons = container.querySelectorAll('button');
    act(() => buttons[1]?.click());
    expect(buttons[1]?.dataset.state).toBe('success');
    expect(vi.getTimerCount()).toBe(1);

    act(() => buttons[0]?.click());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows one status line, with a second line only when a detail is given', () => {
    act(() =>
      root.render(<CompanionHero state="success" status="你又抓住一个 Moment 了，真厉害～" />),
    );

    const copy = () => container.querySelector('.companion-hero-copy')!;
    expect(copy().textContent).toBe('你又抓住一个 Moment 了，真厉害～');
    expect(copy().querySelector('p')).toBeNull();
    expect(copy().querySelector('.companion-hero-meta')).toBeNull();
    expect(container.querySelector('.companion-hero')?.getAttribute('aria-labelledby')).toBe(
      'companion-hero-status',
    );
    expect(container.querySelector('#companion-hero-status')?.tagName).toBe('H2');

    act(() =>
      root.render(
        <CompanionHero state="due" status="Review due" detail="Two reviews are ready today." />,
      ),
    );
    expect(copy().querySelector('h2')?.textContent).toBe('Review due');
    expect(copy().querySelector('p')?.textContent).toBe('Two reviews are ready today.');
  });
});

describe('resolveCompanionHeroState', () => {
  it('uses processing/reviewing, success, due, idle priority without invalid-count flicker', () => {
    expect(
      resolveCompanionHeroState({ processing: true, temporarySuccess: true, dueCount: 4 }),
    ).toBe('reviewing');
    expect(
      resolveCompanionHeroState({ reviewing: true, temporarySuccess: true, dueCount: 4 }),
    ).toBe('reviewing');
    expect(resolveCompanionHeroState({ temporarySuccess: true, dueCount: 4 })).toBe('success');
    expect(resolveCompanionHeroState({ dueCount: 4 })).toBe('due');
    expect(resolveCompanionHeroState({ dueCount: Number.NaN })).toBe('idle');
  });
});

describe('CompanionHero responsive CSS contract', () => {
  const css = readFileSync(resolve('src/styles/global.css'), 'utf8');

  it('constrains the hero and image without horizontal or control overlap', () => {
    expect(css).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(css).toContain('height: clamp(6.75rem, 32vw, 9.0625rem)');
    expect(css).toContain(".companion-hero-image[data-asset-status='loading']");
    expect(css).toContain('pointer-events: none');
    expect(css).toContain('user-select: none');
    expect(css).toContain('@media (max-width: 360px)');
  });

  it('disables all non-essential companion motion for reduced-motion users', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toMatch(
      /prefers-reduced-motion: reduce[\s\S]*?\.companion-hero-image[\s\S]*?animation: none/,
    );
    expect(css).toMatch(
      /prefers-reduced-motion: reduce[\s\S]*?\.companion-hero-success::after[\s\S]*?animation: none/,
    );
    expect(css).not.toContain('companion-hero-breathe');
    expect(css).not.toContain('8s ease-in-out');
  });
});
