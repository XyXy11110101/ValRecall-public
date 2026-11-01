// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearFocusOfStickyBar } from './sticky-bar-clearance';

function barOfHeight(start: number) {
  const bar = document.createElement('div');
  let height = start;
  bar.getBoundingClientRect = () => ({ height }) as DOMRect;
  return {
    bar,
    resize(next: number) {
      height = next;
    },
  };
}

describe('clearFocusOfStickyBar', () => {
  let resized: () => void = () => undefined;
  const disconnect = vi.fn();

  function stubObserver() {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe = vi.fn();
        disconnect = disconnect;
      },
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    disconnect.mockClear();
  });

  const padding = (root: HTMLElement) => root.style.getPropertyValue('scroll-padding-block-end');

  it('reserves the height of the bar and a gap above it', () => {
    stubObserver();
    const root = document.createElement('div');
    clearFocusOfStickyBar(barOfHeight(98.5).bar, root);
    expect(padding(root)).toBe('115px');
  });

  it('follows the bar as it grows', () => {
    stubObserver();
    const root = document.createElement('div');
    const { bar, resize } = barOfHeight(99);
    clearFocusOfStickyBar(bar, root);
    resize(180);
    resized();
    expect(padding(root)).toBe('196px');
  });

  it('reserves nothing while the bar is hidden', () => {
    stubObserver();
    const root = document.createElement('div');
    const { bar, resize } = barOfHeight(99);
    clearFocusOfStickyBar(bar, root);
    resize(0);
    resized();
    expect(padding(root)).toBe('');
  });

  it('goes by the bar on show when another stays mounted but hidden', () => {
    stubObserver();
    const root = document.createElement('div');
    const add = barOfHeight(99);
    const library = barOfHeight(0);
    clearFocusOfStickyBar(add.bar, root);
    const stopLibrary = clearFocusOfStickyBar(library.bar, root);
    expect(padding(root)).toBe('115px');
    // Switching pages, in the order that would otherwise lose the padding.
    add.resize(0);
    library.resize(120);
    resized();
    expect(padding(root)).toBe('136px');
    add.resize(99);
    library.resize(0);
    resized();
    expect(padding(root)).toBe('115px');
    stopLibrary();
    expect(padding(root)).toBe('115px');
  });

  it('gives the page its scrolling back when the bar leaves', () => {
    stubObserver();
    const root = document.createElement('div');
    clearFocusOfStickyBar(barOfHeight(99).bar, root)();
    expect(padding(root)).toBe('');
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('still works once without ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const root = document.createElement('div');
    const stop = clearFocusOfStickyBar(barOfHeight(99).bar, root);
    expect(padding(root)).toBe('115px');
    stop();
    expect(padding(root)).toBe('');
  });
});
