import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REVIEW_ART_SLOTS, reviewSlotPose } from '../companion/companion-scenes';
import { companionArtPath, outfitForDate } from '../companion/wardrobe';
import {
  buildCompanionHomeMessage,
  Companion,
  companionArtVariant,
  companionArtVariants,
  companionMessage,
  type CompanionState,
  preloadCompanionArt,
  reviewCompanionLayers,
  useCompanionArtPreload,
  worriedCompanionLeading,
} from './Companion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Fixed local dates and clocks: the outfit follows the date, the pose follows the moment.
const today = '2026-10-28';
const outfit = outfitForDate(today);
const afternoon = new Date(2026, 9, 28, 14, 0);
const globalCss = readFileSync(resolve('src/styles/global.css'), 'utf8');
const layers = reviewCompanionLayers({ hour: 14, dateKey: today, cardIndex: 0 });

function stubReducedMotion() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

function parse(markup: string) {
  return new DOMParser().parseFromString(markup, 'text/html');
}

function reviewStack(activeLayer: string, state: CompanionState = 'due') {
  return (
    <Companion
      state={state}
      placement="review"
      compact
      message={null}
      dateKey={today}
      layers={layers}
      activeLayer={activeLayer}
    />
  );
}

describe('Companion', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    container.remove();
  });

  const layerImage = (key: string) =>
    container.querySelector<HTMLImageElement>(`img[data-companion-layer="${key}"]`);
  const layerSpan = (key: string) =>
    container.querySelector<HTMLElement>(`span[data-companion-layer="${key}"]`);

  it('draws the chosen pose in the outfit for the date, animated by default', () => {
    const rendered = parse(
      renderToStaticMarkup(<Companion state="idle" pose="read" dateKey={today} count={3} />),
    );
    const shell = rendered.querySelector('.companion');
    expect(rendered.querySelectorAll('img')).toHaveLength(1);
    expect(rendered.querySelector('img')?.getAttribute('src')).toBe(
      companionArtPath(outfit, 'read', 'animated'),
    );
    expect(shell?.getAttribute('data-companion-state')).toBe('idle');
    expect(shell?.getAttribute('data-companion-outfit')).toBe(outfit);
    expect(shell?.getAttribute('data-companion-pose')).toBe('read');
    expect(shell?.getAttribute('data-companion-motion')).toBe('animated');
    expect(shell?.getAttribute('aria-hidden')).toBe('true');
  });

  it('changes outfit with the date, never with the state', () => {
    const tomorrow = '2026-10-29';
    const paths = (['idle', 'due', 'reviewing', 'success'] as const).map((state) =>
      parse(renderToStaticMarkup(<Companion state={state} pose="calm" dateKey={today} />))
        .querySelector('img')
        ?.getAttribute('src'),
    );
    expect(new Set(paths)).toEqual(new Set([companionArtPath(outfit, 'calm', 'animated')]));
    const next = parse(
      renderToStaticMarkup(<Companion state="idle" pose="calm" dateKey={tomorrow} />),
    );
    expect(next.querySelector('img')?.getAttribute('src')).toBe(
      companionArtPath(outfitForDate(tomorrow), 'calm', 'animated'),
    );
    expect(outfitForDate(tomorrow)).not.toBe(outfit);
  });

  it('wears an explicit outfit, such as the one a Review session started in', () => {
    const rendered = parse(
      renderToStaticMarkup(
        <Companion state="idle" pose="tea" dateKey={today} outfit="outfit12" message={null} />,
      ),
    );
    expect(rendered.querySelector('img')?.getAttribute('src')).toBe(
      'assets/companion/chibi/outfit12/tea.anim.svg',
    );
  });

  it('derives the pose from the placement when the caller gives none', () => {
    vi.useFakeTimers();
    vi.setSystemTime(afternoon);
    const src = (element: ReactElement) =>
      parse(renderToStaticMarkup(element)).querySelector('img')?.getAttribute('src');

    expect(src(<Companion state="idle" />)).toBe(companionArtPath(outfit, 'read', 'animated'));
    expect(src(<Companion state="due" count={2} dateKey={today} />)).toMatch(
      new RegExp(`/${outfit}/(?:point|card)\\.anim\\.svg$`),
    );
    expect(src(<Companion state="due" count={0} dateKey={today} />)).toBe(
      companionArtPath(outfit, 'fist', 'animated'),
    );
    expect(src(<Companion state="idle" placement="empty" message={null} />)).toBe(
      companionArtPath(outfit, 'sleepy', 'animated'),
    );
    expect(src(<Companion state="due" placement="tasks" compact dateKey={today} />)).toBe(
      companionArtPath(outfit, 'head-talk', 'animated'),
    );
    expect(src(<Companion state="success" placement="tasks" compact dateKey={today} />)).toBe(
      companionArtPath(outfit, 'head-joy', 'animated'),
    );
  });

  it('keeps a still pose on its static twin', () => {
    const rendered = parse(
      renderToStaticMarkup(<Companion state="reviewing" pose="think" still dateKey={today} />),
    );
    expect(rendered.querySelector('img')?.getAttribute('src')).toBe(
      companionArtPath(outfit, 'think', 'static'),
    );
    expect(rendered.querySelector('.companion')?.getAttribute('data-companion-motion')).toBe(
      'static',
    );
  });

  it('chooses the variant from reduced motion, stillness and the static-only worried head', () => {
    expect(companionArtVariant('wave', { reducedMotion: false })).toBe('animated');
    expect(companionArtVariant('wave', { reducedMotion: true })).toBe('static');
    expect(companionArtVariant('wave', { reducedMotion: false, still: true })).toBe('static');
    expect(companionArtVariant('head-worried', { reducedMotion: false })).toBe('static');
    expect(companionArtVariants('outfit1', ['cheer', 'head-worried'])).toEqual([
      'assets/companion/chibi/outfit1/cheer.anim.svg',
      'assets/companion/chibi/outfit1/cheer.svg',
      'assets/companion/chibi/outfit1/head-worried.svg',
    ]);
    expect(
      companionArtVariants('outfit1', ['cheer', 'head-worried'], { reducedMotion: true }),
    ).toEqual([
      'assets/companion/chibi/outfit1/cheer.svg',
      'assets/companion/chibi/outfit1/head-worried.svg',
    ]);
  });

  it('gives save and sync failures a decorative, still worried head in today’s outfit', () => {
    const rendered = parse(renderToStaticMarkup(<>{worriedCompanionLeading(today)}</>));
    const image = rendered.querySelector('img');
    expect(image?.getAttribute('src')).toBe(companionArtPath(outfit, 'head-worried', 'static'));
    expect(image?.getAttribute('src')).not.toContain('.anim.');
    expect(image?.getAttribute('alt')).toBe('');
    expect(image?.getAttribute('aria-hidden')).toBe('true');
    expect(image?.getAttribute('data-companion-motion')).toBe('static');
  });

  it('drops the worried head quietly when its file is missing', () => {
    act(() => root.render(<>{worriedCompanionLeading(today)}</>));
    act(() => container.querySelector('img')?.dispatchEvent(new Event('error')));
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders the due count through the central message mapping', () => {
    expect(companionMessage('due', 1, 0)).toBe('今天有 1 条复习等你。');
    expect(companionMessage('due', 4, 0)).toBe('今天有 4 条复习等你。');
    expect(companionMessage('reviewing', 4, 0)).toBe('先试着回忆，再揭晓答案。');
  });

  it('keeps a stable abstract Home stage until the private image loads', () => {
    act(() => root.render(<Companion state="idle" pose="calm" dateKey={today} />));
    const companion = container.querySelector<HTMLElement>('.companion');
    const image = container.querySelector('img');

    expect(companion?.hidden).toBe(false);
    expect(companion?.getAttribute('data-companion-asset-status')).toBe('loading');
    expect(container.querySelector('.companion-abstract')).not.toBeNull();
    expect(image?.hidden).toBe(true);
    expect(container.querySelectorAll('img')).toHaveLength(1);
    act(() => image?.dispatchEvent(new Event('load')));
    expect(container.querySelector<HTMLElement>('.companion')?.hidden).toBe(false);
    expect(container.querySelector('.companion')?.getAttribute('data-companion-asset-status')).toBe(
      'ready',
    );
    expect(container.querySelector('.companion-abstract')).toBeNull();
    expect(container.querySelector('img')?.hidden).toBe(false);
  });

  it('keeps a non-blocking abstract Home fallback when the private asset is unavailable', () => {
    act(() => root.render(<Companion state="success" pose="peace" dateKey={today} />));
    const image = container.querySelector('img');

    act(() => image?.dispatchEvent(new Event('error')));

    expect(container.querySelector('.companion')?.getAttribute('data-companion-asset-status')).toBe(
      'missing',
    );
    expect(container.querySelector('.companion-abstract')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('gives each Review slot its own keyed layer, animating only the shown one', () => {
    act(() => root.render(reviewStack('invite')));
    const shell = container.querySelector<HTMLElement>('.companion');

    expect(container.querySelectorAll('.companion-stack-layer')).toHaveLength(5);
    expect(
      [...container.querySelectorAll('span[data-companion-layer]')].map((layer) =>
        layer.getAttribute('data-companion-layer'),
      ),
    ).toEqual([...REVIEW_ART_SLOTS]);
    expect(shell?.hidden).toBe(true);
    const invitePose = reviewSlotPose('invite', { hour: 14, dateKey: today, cardIndex: 0 });
    expect(layerImage('invite')?.getAttribute('src')).toBe(
      companionArtPath(outfit, invitePose, 'animated'),
    );
    for (const key of ['rest', 'recall', 'reveal', 'complete']) {
      expect(layerImage(key)?.getAttribute('src')).not.toContain('.anim.');
      expect(layerImage(key)?.getAttribute('data-companion-motion')).toBe('static');
    }

    act(() => layerImage('invite')?.dispatchEvent(new Event('load')));
    expect(shell?.hidden).toBe(false);
    expect(layerImage('invite')?.classList.contains('is-active')).toBe(true);
    expect(layerSpan('invite')?.classList.contains('is-active')).toBe(true);
    expect(shell?.getAttribute('data-companion-slot')).toBe('invite');
    expect(shell?.getAttribute('data-companion-outfit')).toBe(outfit);
    expect(shell?.getAttribute('data-companion-pose')).toBe(invitePose);
    expect(container.querySelectorAll('img[src$=".anim.svg"]')).toHaveLength(1);
  });

  it('keeps the question still while the user recalls', () => {
    act(() => root.render(reviewStack('recall')));
    const recall = layerImage('recall');
    expect(recall?.getAttribute('src')).toBe(companionArtPath(outfit, 'think', 'static'));
    act(() => recall?.dispatchEvent(new Event('load')));
    expect(container.querySelector('.companion')?.getAttribute('data-companion-motion')).toBe(
      'static',
    );
    expect(container.querySelector('img[src$=".anim.svg"]')).toBeNull();
  });

  it('keeps one stable Review viewport while two slots overlap for the crossfade', () => {
    vi.useFakeTimers();
    act(() => root.render(reviewStack('invite')));
    const shell = container.querySelector<HTMLElement>('.companion');
    const invite = layerImage('invite');
    act(() => invite?.dispatchEvent(new Event('load')));

    act(() => root.render(reviewStack('reveal', 'reviewing')));
    const reveal = layerImage('reveal');
    expect(container.querySelector('.companion')).toBe(shell);
    expect(shell?.getAttribute('data-companion-state')).toBe('reviewing');
    expect(reveal?.getAttribute('src')).toBe(companionArtPath(outfit, 'aha', 'animated'));
    expect(invite?.classList.contains('is-active')).toBe(true);

    act(() => reveal?.dispatchEvent(new Event('load')));
    expect(reveal?.classList.contains('is-active')).toBe(true);
    expect(invite?.classList.contains('is-active')).toBe(false);
    expect(invite?.classList.contains('is-transition-out')).toBe(true);
    expect(layerSpan('reveal')?.classList.contains('is-active')).toBe(true);
    expect(shell?.getAttribute('data-companion-transition-from')).toBe('invite');
    // Only the shown and the outgoing layer may be animated during the crossfade.
    expect(container.querySelectorAll('img[src$=".anim.svg"]')).toHaveLength(2);

    act(() => vi.advanceTimersByTime(219));
    expect(invite?.classList.contains('is-transition-out')).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(shell?.hasAttribute('data-companion-transition-from')).toBe(false);
    expect(container.querySelectorAll('img[src$=".anim.svg"]')).toHaveLength(1);
    expect(layerImage('invite')?.getAttribute('src')).not.toContain('.anim.');
  });

  it('invalidates an obsolete overlap callback when a newer slot wins', () => {
    vi.useFakeTimers();
    act(() => root.render(reviewStack('invite')));
    const shell = container.querySelector<HTMLElement>('.companion');
    act(() => layerImage('invite')?.dispatchEvent(new Event('load')));

    act(() => root.render(reviewStack('reveal', 'reviewing')));
    act(() => layerImage('reveal')?.dispatchEvent(new Event('load')));
    expect(shell?.getAttribute('data-companion-transition-from')).toBe('invite');

    act(() => root.render(reviewStack('complete', 'success')));
    const complete = layerImage('complete');
    act(() => complete?.dispatchEvent(new Event('load')));
    expect(container.querySelector('.companion')).toBe(shell);
    expect(shell?.getAttribute('data-companion-state')).toBe('success');
    expect(shell?.getAttribute('data-companion-transition-from')).toBe('reveal');
    expect(complete?.classList.contains('is-active')).toBe(true);
    expect(layerImage('invite')?.classList.contains('is-transition-out')).toBe(false);

    act(() => vi.advanceTimersByTime(220));
    expect(shell?.getAttribute('data-companion-state')).toBe('success');
    expect(complete?.classList.contains('is-active')).toBe(true);
    expect(shell?.hasAttribute('data-companion-transition-from')).toBe(false);
  });

  it('switches loaded Review slots without an outgoing layer in reduced motion', () => {
    stubReducedMotion();
    act(() => root.render(reviewStack('invite')));
    act(() => {
      for (const image of container.querySelectorAll('img')) image.dispatchEvent(new Event('load'));
    });
    act(() => root.render(reviewStack('reveal', 'reviewing')));
    expect(layerImage('reveal')?.classList.contains('is-active')).toBe(true);
    expect(container.querySelector('.is-transition-out')).toBeNull();
  });

  it('keeps a non-blocking abstract Review fallback when the selected asset fails', () => {
    act(() => root.render(reviewStack('invite')));
    act(() => layerImage('invite')?.dispatchEvent(new Event('error')));

    expect(container.querySelector('.companion')?.hasAttribute('hidden')).toBe(false);
    expect(container.querySelector('.companion-abstract')).not.toBeNull();
  });

  it('keeps the Review asset shell stable when the Review-local dialogue layer is silent', () => {
    act(() => root.render(reviewStack('invite')));
    const shell = container.querySelector('.companion');
    act(() => layerImage('invite')?.dispatchEvent(new Event('load')));

    expect(container.querySelector('.companion')).toBe(shell);
    expect(container.querySelector('.companion-copy')).toBeNull();
    expect(container.querySelector('.companion-asset-stack')).not.toBeNull();
  });

  it('falls back to the macro state’s slot when the caller passes no layers', () => {
    vi.useFakeTimers();
    vi.setSystemTime(afternoon);
    act(() => root.render(<Companion state="success" placement="review" message={null} />));
    const shell = container.querySelector('.companion');
    expect(container.querySelectorAll('.companion-stack-layer')).toHaveLength(5);
    expect(shell?.getAttribute('data-companion-slot')).toBe('complete');
    expect(shell?.getAttribute('data-companion-outfit')).toBe(outfit);
  });

  it('shows no animated file anywhere under reduced motion', () => {
    stubReducedMotion();
    act(() =>
      root.render(
        <>
          <Companion state="idle" pose="wave" dateKey={today} />
          <Companion state="due" placement="tasks" compact dateKey={today} />
          <Companion state="idle" placement="empty" message={null} dateKey={today} />
          {worriedCompanionLeading(today)}
          {reviewStack('invite')}
        </>,
      ),
    );
    act(() => {
      for (const image of container.querySelectorAll('img')) image.dispatchEvent(new Event('load'));
    });
    act(() =>
      root.render(
        <>
          <Companion state="idle" pose="wave" dateKey={today} />
          <Companion state="due" placement="tasks" compact dateKey={today} />
          <Companion state="idle" placement="empty" message={null} dateKey={today} />
          {worriedCompanionLeading(today)}
          {reviewStack('complete', 'success')}
        </>,
      ),
    );
    const sources = [...container.querySelectorAll('img')].map((image) =>
      image.getAttribute('src'),
    );
    expect(sources.length).toBeGreaterThan(5);
    expect(sources.filter((source) => source?.includes('.anim.svg'))).toEqual([]);
    for (const shell of container.querySelectorAll('.companion')) {
      expect(shell.getAttribute('data-companion-motion')).toBe('static');
    }
  });

  it.each([
    ['empty', false],
    ['home', false],
    ['review', true],
    ['tasks', true],
  ] as const)('uses passive route-specific placement for %s', (placement, compact) => {
    const rendered = parse(
      renderToStaticMarkup(
        <Companion state="idle" placement={placement} compact={compact} dateKey={today} />,
      ),
    );
    const companion = rendered.querySelector('.companion');

    expect(companion?.getAttribute('data-companion-placement')).toBe(placement);
    expect(companion?.getAttribute('aria-hidden')).toBe('true');
    expect(companion?.classList.contains(`companion-${placement}`)).toBe(true);
    expect(globalCss).toMatch(/\.companion\s*\{[\s\S]*?pointer-events: none/);
    expect(globalCss).not.toMatch(/\.companion[^{]*\{[^}]*animation:[^;]*infinite/s);
  });
});

describe('companion art preload', () => {
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
    delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
    vi.unstubAllGlobals();
  });

  it('fetches no animated twin ahead of time under reduced motion', async () => {
    stubReducedMotion();
    const decoded: string[] = [];
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value(this: HTMLImageElement) {
        decoded.push(this.getAttribute('src') ?? '');
        return Promise.resolve();
      },
    });
    const date = '2026-11-07';
    function Probe() {
      const ready = useCompanionArtPreload(['thumbs', 'note'], date);
      return <span data-ready={ready} />;
    }
    act(() =>
      root.render(
        <>
          <Probe />
          <Companion state="due" placement="review" compact message={null} dateKey={date} />
        </>,
      ),
    );
    await act(async () => Promise.resolve());
    expect(container.querySelector('span')?.getAttribute('data-ready')).toBe('true');
    expect(decoded).toContain(companionArtPath(outfitForDate(date), 'thumbs', 'static'));
    expect(decoded.filter((path) => path.includes('.anim.svg'))).toEqual([]);
  });

  it('decodes both twins of each exact path, once', async () => {
    const decoded: string[] = [];
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value(this: HTMLImageElement) {
        decoded.push(this.getAttribute('src') ?? '');
        return Promise.resolve();
      },
    });
    const paths = companionArtVariants('outfit2', ['clap']);
    await expect(preloadCompanionArt(paths)).resolves.toBe(true);
    await expect(preloadCompanionArt(paths)).resolves.toBe(true);
    expect(decoded).toEqual([
      'assets/companion/chibi/outfit2/clap.anim.svg',
      'assets/companion/chibi/outfit2/clap.svg',
    ]);
  });

  it('reports a view ready only once its poses are decoded in today’s outfit', async () => {
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value: () => Promise.resolve(),
    });
    function Probe() {
      const ready = useCompanionArtPreload(['thumbs', 'jump'], '2026-11-03');
      return <span data-ready={ready} />;
    }
    act(() => root.render(<Probe />));
    await act(async () => Promise.resolve());
    expect(container.querySelector('span')?.getAttribute('data-ready')).toBe('true');
  });

  it('stays false when images cannot be decoded', async () => {
    function Probe() {
      const ready = useCompanionArtPreload(['peace'], '2026-11-04');
      return <span data-ready={ready} />;
    }
    act(() => root.render(<Probe />));
    await act(async () => Promise.resolve());
    expect(container.querySelector('span')?.getAttribute('data-ready')).toBe('false');
  });
});

describe('buildCompanionHomeMessage', () => {
  it.each([
    [5, 3, '今天有 5 条复习和 3 项任务等你。'],
    [1, 0, '今天有 1 条复习等你。'],
    [0, 2, '复习已经完成。还剩 2 项任务。'],
    [0, 0, '今天都跟上进度了。'],
  ])('combines review and task counts without content (%s, %s)', (reviews, tasks, expected) => {
    expect(buildCompanionHomeMessage(reviews, tasks)).toBe(expected);
  });
});
