import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REFRESH_REVEAL_DELAY_MS, useDelayedFlag } from './use-delayed-flag';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ active }: { active: boolean }) {
  return <p>{useDelayedFlag(active) ? 'shown' : 'quiet'}</p>;
}

describe('delayed refresh indicator', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('never shows work that ends quickly, and shows slow work until it ends', () => {
    act(() => root.render(<Probe active />));
    act(() => vi.advanceTimersByTime(REFRESH_REVEAL_DELAY_MS - 1));
    act(() => root.render(<Probe active={false} />));
    expect(container.textContent).toBe('quiet');
    expect(vi.getTimerCount()).toBe(0);

    act(() => root.render(<Probe active />));
    act(() => vi.advanceTimersByTime(REFRESH_REVEAL_DELAY_MS - 1));
    expect(container.textContent).toBe('quiet');
    act(() => vi.advanceTimersByTime(1));
    expect(container.textContent).toBe('shown');
    act(() => root.render(<Probe active={false} />));
    expect(container.textContent).toBe('quiet');
    // A new period starts its own delay: the last reveal is never reused.
    act(() => root.render(<Probe active />));
    expect(container.textContent).toBe('quiet');
  });

  it('clears its single timer on unmount', () => {
    act(() => root.render(<Probe active />));
    expect(vi.getTimerCount()).toBe(1);
    act(() => root.render(<></>));
    expect(vi.getTimerCount()).toBe(0);
  });
});
