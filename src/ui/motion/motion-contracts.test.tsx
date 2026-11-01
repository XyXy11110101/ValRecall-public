import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MOTION_DURATION_MS, MOTION_TIMING_MS } from './contracts';
import { safeViewTransition, type ViewTransitionLike } from './safeViewTransition';
import { REDUCED_MOTION_QUERY, useReducedMotion } from './useReducedMotion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tokenCss = readFileSync(resolve('src/ui/motion/motion-tokens.css'), 'utf8');
const utilityCss = readFileSync(resolve('src/ui/motion/motion-utilities.css'), 'utf8');
const globalCss = readFileSync(resolve('src/styles/global.css'), 'utf8').replace(/\r\n/g, '\n');
const motionRuntimeSource = [
  readFileSync(resolve('src/ui/motion/useReducedMotion.ts'), 'utf8'),
  readFileSync(resolve('src/ui/motion/safeViewTransition.ts'), 'utf8'),
  readFileSync(resolve('src/ui/motion/MotionDisclosure.tsx'), 'utf8'),
].join('\n');
const fullTabMotionSource = [
  readFileSync(resolve('src/dashboard/LibraryView.tsx'), 'utf8'),
  readFileSync(resolve('src/dashboard/TasksView.tsx'), 'utf8'),
].join('\n');
const todayViewSource = readFileSync(resolve('src/dashboard/TodayView.tsx'), 'utf8');
const reviewCompanionSource = readFileSync(resolve('src/dashboard/review-companion.ts'), 'utf8');
// The wardrobe picks outfits and poses by date, hour, card and count: never by chance or a loop.
const companionSources = Object.fromEntries(
  [
    'src/companion/wardrobe.ts',
    'src/companion/companion-scenes.ts',
    'src/companion/wardrobe-preference.ts',
    'src/companion/CompanionWardrobe.tsx',
    'src/dashboard/Companion.tsx',
    'src/dashboard/use-task-celebration.ts',
    'src/sidepanel/CompanionHero.tsx',
    'src/reminders/notification-icon.ts',
  ].map((path) => [path, readFileSync(resolve(path), 'utf8')]),
);
const migrationsSource = readFileSync(resolve('src/database/migrations.ts'), 'utf8');
const fsrsSource = readFileSync(resolve('src/fsrs/FsrsService.ts'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve('public/manifest.json'), 'utf8')) as {
  permissions: string[];
  host_permissions: string[];
  content_scripts: Array<{ matches: string[] }>;
};
const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe('motion foundation CSS contract', () => {
  it('defines the shared semantic duration, easing, distance and opacity tokens', () => {
    for (const [name, value] of Object.entries(MOTION_DURATION_MS)) {
      expect(tokenCss).toContain(`--motion-${name}: ${value}ms`);
    }
    for (const [name, value] of Object.entries(MOTION_TIMING_MS)) {
      const cssName = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      expect(tokenCss).toContain(`--motion-${cssName}: ${value}ms`);
    }
    expect(tokenCss).toContain('--ease-standard:');
    expect(tokenCss).toContain('--ease-enter:');
    expect(tokenCss).toContain('--ease-exit:');
    expect(tokenCss).toContain('--motion-distance-xs: 4px');
    expect(tokenCss).toContain('--motion-distance-sm: 8px');
    expect(tokenCss).toContain('--motion-distance-md: 12px');
    expect(tokenCss).toContain('--motion-muted-opacity:');
  });

  it('renders navigation, counts and content without decorative movement', () => {
    expect(utilityCss).toContain('.motion-count-change');
    expect(utilityCss).toContain('animation: none');
    expect(utilityCss).not.toContain('translateY');
    expect(utilityCss).not.toContain('scale(');
    expect(
      [...globalCss.matchAll(/animation:\s*([^;]+);/g)].every(
        (match) => match[1]?.trim() === 'none',
      ),
    ).toBe(true);
    expect(globalCss).not.toContain('@keyframes');
  });

  it('retains only the genuine loading loop and disables it for reduced motion', () => {
    expect(utilityCss.match(/@keyframes/g)).toHaveLength(1);
    expect(utilityCss).toContain('animation: motion-loading 900ms linear infinite');
    expect(utilityCss).toMatch(
      /prefers-reduced-motion: reduce[\s\S]*?\.motion-loading-indicator[\s\S]*?animation: none/,
    );
    expect(utilityCss).toContain('scroll-behavior: auto !important');
  });

  it('adds no animation framework dependency', () => {
    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
    for (const dependency of [
      'framer-motion',
      'react-spring',
      '@react-spring/web',
      'gsap',
      'motion',
      'motion-one',
    ]) {
      expect(dependencies).not.toHaveProperty(dependency);
    }
  });

  it('creates no animation data loop, retained interval, or large View Transition snapshot', () => {
    expect(motionRuntimeSource).not.toContain('indexedDB');
    expect(motionRuntimeSource).not.toContain('repository');
    expect(motionRuntimeSource).not.toContain('FsrsService');
    expect(motionRuntimeSource).not.toContain('setInterval');
    expect(fullTabMotionSource).not.toContain('setInterval');
    expect(
      [...globalCss.matchAll(/view-transition-name:\s*([a-z-]+)/g)]
        .map((match) => match[1])
        .filter((name) => name !== 'none'),
    ).toEqual([
      'dashboard-active-navigation',
      'dashboard-page-heading',
      'tasks-selected-section',
      'settings-selected-category',
    ]);
    expect(globalCss).toContain('::view-transition-old(root)');
    expect(globalCss).not.toMatch(
      /\.(?:library-row|task-row|source-group)\b[^{}]*\{[^{}]*view-transition-name/s,
    );
    expect(globalCss).not.toContain('infinite');
  });

  it('keeps full-tab motion responsive, passive, and removable in reduced motion', () => {
    expect(globalCss).toMatch(/\.home-layout\s*\{[^}]*container: home-layout \/ inline-size/s);
    expect(globalCss).toMatch(
      /@container home-layout \(min-width: 1024px\)[\s\S]*?\.home-workspaces,[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/,
    );
    expect(globalCss).toMatch(
      /@container home-layout \(max-width: 36em\)[\s\S]*?\.home-summary-card/,
    );
    expect(globalCss).toMatch(/\.companion\s*\{[\s\S]*?pointer-events: none/);
    expect(globalCss).toMatch(
      /prefers-reduced-motion: reduce[\s\S]*?\.task-motion-restored[\s\S]*?\.task-motion-updated[\s\S]*?animation: none/,
    );
    expect(globalCss).toMatch(
      /prefers-reduced-motion: reduce[\s\S]*?::view-transition-group\(dashboard-page-heading\)[\s\S]*?animation: none/,
    );
  });

  it('keeps todo completion motion finite, scoped to its components and removable', () => {
    const taskCss = readFileSync(resolve('src/dashboard/task-feedback.css'), 'utf8');
    expect(taskCss).not.toMatch(/infinite|backdrop-filter|filter:\s*blur/u);
    expect(taskCss).toContain(":is(.home-view, .tasks-view)[data-reduced-motion='true'] *::before");
    // Pseudo-elements inside :is() are invalid and would silently drop from the list.
    expect(taskCss).not.toMatch(/:is\([^)]*::/u);
    expect(taskCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important[\s\S]*transition: none !important/u,
    );
    expect(globalCss).not.toContain('task-feedback.css');
    for (const component of ['HomeTasks.tsx', 'TasksView.tsx', 'TaskCelebration.tsx']) {
      expect(readFileSync(resolve('src/dashboard', component), 'utf8')).toContain(
        "import './task-feedback.css';",
      );
    }
    const celebration = readFileSync(resolve('src/dashboard/use-task-celebration.ts'), 'utf8');
    expect(celebration).not.toContain('setInterval');
    expect(celebration).toContain("addEventListener('visibilitychange'");
  });

  it('keeps Review imagery complete and motion optional without moving the question on Reveal', () => {
    const reviewCss = readFileSync(resolve('src/dashboard/review.css'), 'utf8');
    expect(reviewCss).toContain('object-fit: contain');
    expect(reviewCss).not.toMatch(/infinite|filter:.*blur|backdrop-filter|linear-gradient/);
    expect(reviewCss).toContain("[data-reduced-motion='true']");
    expect(reviewCss).toContain('prefers-reduced-motion: reduce');
    expect(reviewCss).toContain('animation: none !important');
    expect(reviewCss).toContain('transition: none !important');
    expect(reviewCss).not.toMatch(/revealed[^}]*\.recall-prompt/);
    expect(todayViewSource).not.toContain('data-review-composition="cue-sprite"');
    expect(reviewCss).not.toMatch(/\.review-speech[^}]*position: (?:absolute|fixed)/s);
  });

  it('does not couple motion to schema, FSRS, or new extension authority', () => {
    expect(migrationsSource).toContain('export const DATABASE_VERSION = 6');
    expect(`${migrationsSource}\n${fsrsSource}`).not.toContain('ui/motion');
    expect(reviewCompanionSource).not.toContain('Math.random');
    expect(reviewCompanionSource).not.toContain('setTimeout');
    expect(reviewCompanionSource).not.toContain('setInterval');
    expect(reviewCompanionSource).not.toContain('repository');
    expect(reviewCompanionSource).not.toContain('indexedDB');
    for (const [path, source] of Object.entries(companionSources)) {
      expect(source, path).not.toContain('Math.random');
      expect(source, path).not.toContain('setInterval');
      expect(source, path).not.toContain('requestAnimationFrame');
      expect(source, path).not.toMatch(/@keyframes|\binfinite\b/u);
      expect(source, path).not.toContain('indexedDB');
    }
    expect(manifest.permissions).toEqual([
      'activeTab',
      'alarms',
      'notifications',
      'scripting',
      'storage',
      'sidePanel',
    ]);
    expect(manifest.host_permissions).toEqual([
      'https://www.bilibili.com/video/*',
      'https://www.bilibili.com/zh-Hans/video/*',
      'https://www.bilibili.com/zh-Hant/video/*',
      'https://www.bilibili.com/en/video/*',
      'https://www.bilibili.com/ja/video/*',
      'https://bilibili.com/video/*',
      'https://bilibili.com/zh-Hans/video/*',
      'https://bilibili.com/zh-Hant/video/*',
      'https://bilibili.com/en/video/*',
      'https://bilibili.com/ja/video/*',
      'https://www.bilibili.com/list/watchlater*',
      'https://www.bilibili.com/zh-Hans/list/watchlater*',
      'https://www.bilibili.com/zh-Hant/list/watchlater*',
      'https://www.bilibili.com/en/list/watchlater*',
      'https://www.bilibili.com/ja/list/watchlater*',
      'https://www.youtube.com/watch*',
      'https://www.douyin.com/video/*',
    ]);
    expect(manifest.content_scripts).toHaveLength(1);
    expect(manifest.content_scripts[0]?.matches).toEqual(manifest.host_permissions);
  });
});

describe('safeViewTransition', () => {
  it('falls back to one immediate update when the API is unavailable', () => {
    const update = vi.fn();
    const result = safeViewTransition(update, {
      documentRef: document,
      reducedMotion: false,
    });
    expect(result).toBeNull();
    expect(update).toHaveBeenCalledOnce();
  });

  it('respects reduced motion without invoking an available transition API', () => {
    const update = vi.fn();
    const startViewTransition = vi.fn();
    const documentRef = Object.assign(document, { startViewTransition });

    const result = safeViewTransition(update, { documentRef, reducedMotion: true });

    expect(result).toBeNull();
    expect(update).toHaveBeenCalledOnce();
    expect(startViewTransition).not.toHaveBeenCalled();
    Reflect.deleteProperty(document, 'startViewTransition');
  });

  it('does not invoke available View Transitions and applies the update exactly once', () => {
    const transition: ViewTransitionLike = {
      finished: Promise.resolve(),
      ready: Promise.resolve(),
      updateCallbackDone: Promise.resolve(),
      skipTransition: vi.fn(),
    };
    const update = vi.fn();
    const startViewTransition = vi.fn((callback: () => void) => {
      callback();
      return transition;
    });
    const documentRef = Object.assign(document, { startViewTransition });

    expect(safeViewTransition(update, { documentRef, reducedMotion: false })).toBeNull();
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
    Reflect.deleteProperty(document, 'startViewTransition');
  });

  it('recovers with an immediate update when the transition API throws', () => {
    const update = vi.fn();
    const documentRef = Object.assign(document, {
      startViewTransition: vi.fn(() => {
        throw new Error('transition unavailable');
      }),
    });

    expect(safeViewTransition(update, { documentRef, reducedMotion: false })).toBeNull();
    expect(update).toHaveBeenCalledOnce();
    Reflect.deleteProperty(document, 'startViewTransition');
  });
});

describe('useReducedMotion', () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: originalMatchMedia,
    });
  });

  it('subscribes once and reflects operating-system preference changes', () => {
    let matches = false;
    let listener: (() => void) | null = null;
    const mediaQuery = {
      get matches() {
        return matches;
      },
      media: REDUCED_MOTION_QUERY,
      onchange: null,
      addEventListener: vi.fn((_type: string, nextListener: () => void) => {
        listener = nextListener;
      }),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } satisfies MediaQueryList;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => mediaQuery),
    });

    function Harness() {
      const reduced = useReducedMotion();
      return <span data-reduced={reduced}>{String(reduced)}</span>;
    }

    act(() => root.render(<Harness />));
    expect(container.querySelector('span')?.dataset.reduced).toBe('false');

    matches = true;
    act(() => listener?.());
    expect(container.querySelector('span')?.dataset.reduced).toBe('true');
    expect(mediaQuery.addEventListener).toHaveBeenCalledOnce();
  });
});
