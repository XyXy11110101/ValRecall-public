import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MOBILE_COMPANION_REACTION_MS,
  MobileCompanion,
  mobileCompanionOutfit,
  type MobileCompanionProps,
} from './MobileCompanion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: MobileCompanionProps = {
  active: true,
  today: '2026-10-28',
  now: new Date(2026, 9, 28, 9, 0),
  loadError: false,
  openTasks: 2,
  completedToday: 0,
  completion: null,
};

describe('MobileCompanion', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function render(props: Partial<MobileCompanionProps> = {}) {
    await act(async () => root.render(<MobileCompanion {...base} {...props} />));
  }
  const head = () => container.querySelector<HTMLImageElement>('.mobile-companion-head');
  const cheer = () => container.querySelector<HTMLElement>('.mobile-companion-cheer');
  const cheerArt = () => container.querySelector<HTMLImageElement>('.mobile-companion-cheer-art');
  const visible = () => cheer()?.classList.contains('is-visible') ?? false;

  it('shows the mood on the head: smile, worried, joy and sleepy', async () => {
    await render();
    expect(head()?.dataset.companionPose).toBe('head-smile');
    expect(head()?.getAttribute('src')).toBe('assets/companion/chibi/outfit7/head-smile.anim.svg');

    await render({ openTasks: null });
    expect(head()?.dataset.companionPose).toBe('head-smile');

    await render({ loadError: true, openTasks: null });
    expect(head()?.dataset.companionPose).toBe('head-worried');
    // The worried face is only a still, even with motion allowed.
    expect(head()?.getAttribute('src')).toBe('assets/companion/chibi/outfit7/head-worried.svg');
    expect(head()?.dataset.companionMotion).toBe('static');

    await render({ openTasks: 0, completedToday: 3 });
    expect(head()?.dataset.companionPose).toBe('head-joy');

    await render({ openTasks: 0, completedToday: 0 });
    expect(head()?.dataset.companionPose).toBe('head-sleepy');
    expect(head()?.getAttribute('src')).toBe('assets/companion/chibi/outfit7/head-sleepy.anim.svg');
  });

  it('is decorative: no text, no alt, hidden from assistive technology', async () => {
    await render({ completion: { ordinal: 0, seq: 1 } });
    expect(container.textContent).toBe('');
    for (const image of container.querySelectorAll('img')) {
      expect(image.getAttribute('alt')).toBe('');
      expect(image.getAttribute('aria-hidden')).toBe('true');
    }
    expect(cheer()?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('button, a, [tabindex]')).toHaveLength(0);
  });

  it('pops the cheer up for exactly 2.4 s after a saved completion, with a joyful head', async () => {
    expect(MOBILE_COMPANION_REACTION_MS).toBe(2400);
    await render();
    expect(visible()).toBe(false);
    expect(cheerArt()?.getAttribute('src')).toBe('assets/companion/chibi/outfit7/cheer.svg');

    await render({ completion: { ordinal: 1, seq: 1 }, completedToday: 2, openTasks: 1 });
    expect(visible()).toBe(true);
    expect(cheer()?.dataset.companionVisible).toBe('true');
    expect(cheerArt()?.dataset.companionPose).toBe('clap');
    expect(cheerArt()?.getAttribute('src')).toBe('assets/companion/chibi/outfit7/clap.anim.svg');
    expect(head()?.dataset.companionPose).toBe('head-joy');

    await act(async () => vi.advanceTimersByTimeAsync(MOBILE_COMPANION_REACTION_MS - 1));
    expect(visible()).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(visible()).toBe(false);
    // Hidden, the figure keeps its pose as a still, and the head returns to the open todos.
    expect(cheerArt()?.getAttribute('src')).toBe('assets/companion/chibi/outfit7/clap.svg');
    expect(head()?.dataset.companionPose).toBe('head-smile');
  });

  it('cycles cheer, clap and thumbs by the ordinal fixed at the completion', async () => {
    const poses: string[] = [];
    for (const [seq, ordinal] of [0, 1, 2, 3].entries()) {
      await render({ completion: { ordinal, seq: seq + 1 }, completedToday: 9 });
      poses.push(cheerArt()?.dataset.companionPose ?? '');
    }
    expect(poses).toEqual(['cheer', 'clap', 'thumbs', 'cheer']);
    // A later count does not move the pose of a running reaction.
    await render({ completion: { ordinal: 3, seq: 4 }, completedToday: 10 });
    expect(cheerArt()?.dataset.companionPose).toBe('cheer');
  });

  it('restarts the hold for a new completion', async () => {
    await render({ completion: { ordinal: 0, seq: 1 } });
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await render({ completion: { ordinal: 1, seq: 2 } });
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(visible()).toBe(true);
    expect(cheerArt()?.dataset.companionPose).toBe('clap');
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(visible()).toBe(false);
  });

  it('clears the reaction when the app goes to the background', async () => {
    await render({ completion: { ordinal: 0, seq: 1 } });
    expect(visible()).toBe(true);
    await act(async () => window.dispatchEvent(new Event('valrecall-app-background')));
    expect(visible()).toBe(false);
    expect(head()?.dataset.companionPose).toBe('head-smile');
    // Coming back does not replay it.
    await act(async () => window.dispatchEvent(new Event('valrecall-app-resume')));
    expect(visible()).toBe(false);
  });

  it('clears the reaction when the page is hidden', async () => {
    await render({ completion: { ordinal: 0, seq: 1 } });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(visible()).toBe(false);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(visible()).toBe(false);
  });

  it('uses only still twins under reduced motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    await render({ completion: { ordinal: 2, seq: 1 } });
    expect(visible()).toBe(true);
    const sources = [...container.querySelectorAll('img')].map((image) => image.src);
    expect(sources).toHaveLength(2);
    for (const source of sources) expect(source).not.toMatch(/\.anim\.svg$/u);
    expect(cheerArt()?.getAttribute('src')).toBe('assets/companion/chibi/outfit7/thumbs.svg');
    expect(head()?.getAttribute('src')).toBe('assets/companion/chibi/outfit7/head-joy.svg');
  });

  it("wears the snapshot day's outfit, else this device's local day, never a pin", async () => {
    expect(mobileCompanionOutfit('2026-10-28', new Date(2026, 0, 1))).toBe('outfit7');
    expect(mobileCompanionOutfit(null, new Date(2026, 9, 29, 23, 59))).toBe('outfit8');
    await render({ today: '2026-10-29', now: new Date(2026, 9, 28, 23, 30) });
    expect(head()?.dataset.companionOutfit).toBe('outfit8');
    expect(head()?.getAttribute('src')).toBe('assets/companion/chibi/outfit8/head-smile.anim.svg');
    await render({ today: null, now: new Date(2026, 9, 28, 9, 0) });
    expect(head()?.dataset.companionOutfit).toBe('outfit7');
    expect(cheerArt()?.dataset.companionOutfit).toBe('outfit7');
    // A desktop pin lives in extension storage, which the phone never reads.
    localStorage.setItem('valrecall.companionWardrobe', '{"mode":"pinned","outfit":"outfit1"}');
    await render({ today: '2026-10-28' });
    expect(head()?.dataset.companionOutfit).toBe('outfit7');
    localStorage.removeItem('valrecall.companionWardrobe');
  });

  it('hides an image that fails to load, and a new pose starts fresh', async () => {
    await render();
    await act(async () => head()!.dispatchEvent(new Event('error')));
    expect(head()?.hidden).toBe(true);
    await render({ openTasks: 0, completedToday: 0 });
    expect(head()?.dataset.companionPose).toBe('head-sleepy');
    expect(head()?.hidden).toBe(false);
  });

  it('renders nothing off the 待办 page, while a running hold keeps time', async () => {
    await render({ completion: { ordinal: 0, seq: 1 } });
    await render({ active: false, completion: { ordinal: 0, seq: 1 } });
    expect(container.childElementCount).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await render({ active: true, completion: { ordinal: 0, seq: 1 } });
    expect(visible()).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1400));
    expect(visible()).toBe(false);
  });
});
