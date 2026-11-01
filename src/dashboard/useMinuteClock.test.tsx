import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMinuteClock } from './useMinuteClock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useMinuteClock', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T12:00:30.000Z'));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('uses one coarse timer and refreshes on the next minute', () => {
    act(() => root.render(<ClockProbe />));
    expect(vi.getTimerCount()).toBe(1);
    expect(container.textContent).toContain('12:00:30');

    act(() => vi.advanceTimersByTime(30_020));
    expect(container.textContent).toContain('12:01:00');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('refreshes when the document becomes visible without creating timers per item', () => {
    act(() => root.render(<ClockProbe />));
    vi.setSystemTime(new Date('2026-07-21T12:04:00.000Z'));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(container.textContent).toContain('12:04:00');
    expect(vi.getTimerCount()).toBe(1);
  });
});

function ClockProbe() {
  const now = useMinuteClock(() => new Date());
  return <time>{now.toISOString().slice(11, 19)}</time>;
}
