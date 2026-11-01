import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TASK_CELEBRATION_MS, type TaskCelebration } from '../shared/task-celebration';
import { TaskCoinLayer } from './TaskCelebration';
import { useTaskCelebration } from './use-task-celebration';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const celebration = (overrides: Partial<TaskCelebration> = {}): TaskCelebration => ({
  id: 'al-9',
  taskId: 'task',
  localDate: '2026-10-24',
  amount: 5,
  kind: 'rewarded',
  praise: '你又完成一件啦！',
  ...overrides,
});

function placeAt(element: HTMLElement, left: number, top: number) {
  element.getBoundingClientRect = () =>
    ({ left, top, width: 20, height: 20, right: left + 20, bottom: top + 20 }) as DOMRect;
}

describe('todo completion coin layer', () => {
  let root: Root;
  let container: HTMLDivElement;
  let origin: HTMLButtonElement;
  let wallet: HTMLSpanElement;
  beforeEach(() => {
    container = document.createElement('div');
    origin = document.createElement('button');
    origin.dataset.celebrationOrigin = 'al-9';
    wallet = document.createElement('span');
    wallet.dataset.walletTarget = 'home';
    placeAt(origin, 600, 400);
    placeAt(wallet, 200, 300);
    document.body.append(container, origin, wallet);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    origin.remove();
    wallet.remove();
    vi.useRealTimers();
  });
  const layer = () => document.body.querySelector('.task-coin-layer');

  it('flies a decorative coin from the stamped check to the nearest wallet number', () => {
    act(() => root.render(<TaskCoinLayer celebration={celebration()} reducedMotion={false} />));
    expect(layer()?.getAttribute('aria-hidden')).toBe('true');
    expect(layer()?.hasAttribute('inert')).toBe(true);
    expect(layer()?.parentElement).toBe(document.body);
    const coin = layer()?.querySelector<HTMLElement>('.task-coin');
    expect(coin?.style.getPropertyValue('--coin-dx')).toBe('-400px');
    expect(coin?.style.getPropertyValue('--coin-dy')).toBe('-100px');
    expect(layer()?.querySelector('.task-coin-tag')?.textContent).toBe('+5 元');
  });

  it('bumps the wallet once when the coin lands, and never after unmount', () => {
    vi.useFakeTimers();
    const animate = vi.fn();
    wallet.animate = animate;
    act(() => root.render(<TaskCoinLayer celebration={celebration()} reducedMotion={false} />));
    act(() =>
      vi.advanceTimersByTime(TASK_CELEBRATION_MS.coinDelay + TASK_CELEBRATION_MS.coinFlight),
    );
    expect(animate).toHaveBeenCalledOnce();
    act(() =>
      root.render(
        <TaskCoinLayer celebration={celebration({ id: 'al-10' })} reducedMotion={false} />,
      ),
    );
    act(() => root.render(<></>));
    act(() => vi.advanceTimersByTime(2000));
    expect(animate).toHaveBeenCalledOnce();
  });

  it('shows a static receipt tag instead of motion for reduced motion', () => {
    wallet.animate = vi.fn();
    act(() => root.render(<TaskCoinLayer celebration={celebration()} reducedMotion />));
    expect(layer()?.querySelector('.task-coin')).toBeNull();
    expect(layer()?.querySelector('.task-coin-tag.is-static')?.textContent).toBe('+5 元');
    expect(wallet.animate).not.toHaveBeenCalled();
  });

  it('renders nothing for a stamp without confirmed money or with nothing visible', () => {
    act(() =>
      root.render(<TaskCoinLayer celebration={celebration({ amount: 0 })} reducedMotion={false} />),
    );
    expect(layer()).toBeNull();
    wallet.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect;
    origin.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect;
    act(() => root.render(<TaskCoinLayer celebration={celebration()} reducedMotion />));
    expect(layer()).toBeNull();
  });

  it('shows the amount where the coin starts when no wallet is on screen', () => {
    // The wallet scrolled away (a long 即将到来 list, or a narrow page scrolled to the end).
    wallet.getBoundingClientRect = () =>
      ({ left: 200, top: -300, width: 20, height: 20, right: 220, bottom: -280 }) as DOMRect;
    act(() => root.render(<TaskCoinLayer celebration={celebration()} reducedMotion={false} />));
    const coin = layer()?.querySelector<HTMLElement>('.task-coin.is-rising');
    expect(coin?.style.getPropertyValue('--coin-x')).toBe('610px');
    const tag = layer()?.querySelector<HTMLElement>('.task-coin-tag.at-origin');
    expect(tag?.textContent).toBe('+5 元');
    expect(tag?.style.getPropertyValue('--tag-x')).toBe('610px');
    expect(tag?.style.getPropertyValue('--tag-y')).toBe(`${410 - 18}px`);
    // Reduced motion: no coin, the static receipt beside the row instead of nothing at all.
    origin.dataset.celebrationOrigin = 'al-11';
    act(() =>
      root.render(<TaskCoinLayer celebration={celebration({ id: 'al-11' })} reducedMotion />),
    );
    expect(layer()?.querySelector('.task-coin')).toBeNull();
    expect(layer()?.querySelector('.task-coin-tag.is-static.at-origin')?.textContent).toBe('+5 元');
  });

  it('keeps the coin on its content when the page scrolls, instead of cancelling it', () => {
    act(() => root.render(<TaskCoinLayer celebration={celebration()} reducedMotion={false} />));
    const track = () => layer()?.querySelector<HTMLElement>('.task-coin-track');
    expect(track()?.style.transform).toBe('');
    // A late event from a scroll made before the measurement changes nothing.
    act(() => window.dispatchEvent(new Event('scroll')));
    expect(track()?.style.transform).toBe('');
    // The page moved (the reader scrolled, or a shorter list clamped the offset): the coin
    // and its landing tag move with the row and the wallet, and are never removed.
    const scrollY = vi.spyOn(window, 'scrollY', 'get').mockReturnValue(120);
    try {
      act(() => window.dispatchEvent(new Event('scroll')));
      expect(layer()?.querySelector('.task-coin')).not.toBeNull();
      expect(layer()?.querySelector('.task-coin-tag')).not.toBeNull();
      expect(track()?.style.transform).toBe('translate(0px, -120px)');
      scrollY.mockReturnValue(0);
      act(() => window.dispatchEvent(new Event('scroll')));
      expect(track()?.style.transform).toBe('');
    } finally {
      scrollY.mockRestore();
    }
    // Unmounting removes the listener with the layer.
    act(() => root.render(<></>));
    expect(layer()).toBeNull();
  });

  it('keeps an in-place amount in view when a shorter page clamps the offset', () => {
    // Scrolled to the end of a narrow page; the finished row then leaves the list, the page
    // gets 188px shorter and the browser clamps the offset from 1420 to 1232.
    const scrollY = vi.spyOn(window, 'scrollY', 'get').mockReturnValue(1420);
    const height = vi
      .spyOn(document.documentElement, 'scrollHeight', 'get')
      .mockReturnValue(1420 + window.innerHeight);
    const track = () => layer()?.querySelector<HTMLElement>('.task-coin-track');
    const clamp = () => {
      scrollY.mockReturnValue(1232);
      height.mockReturnValue(1232 + window.innerHeight);
      act(() => window.dispatchEvent(new Event('scroll')));
    };
    try {
      // No wallet on screen: the amount rises where the row was, and stays visible.
      wallet.getBoundingClientRect = () =>
        ({ left: 200, top: -300, width: 20, height: 20, right: 220, bottom: -280 }) as DOMRect;
      act(() => root.render(<TaskCoinLayer celebration={celebration()} reducedMotion={false} />));
      expect(layer()?.querySelector('.task-coin.is-rising')).not.toBeNull();
      clamp();
      expect(track()?.style.transform).toBe('');
      expect(layer()?.querySelector('.task-coin-tag.at-origin')?.textContent).toBe('+5 元');

      // With a wallet to reach, the coin follows the content so it still lands on it.
      act(() => root.render(<></>));
      scrollY.mockReturnValue(1420);
      height.mockReturnValue(1420 + window.innerHeight);
      placeAt(wallet, 200, 300);
      origin.dataset.celebrationOrigin = 'al-15';
      act(() =>
        root.render(
          <TaskCoinLayer celebration={celebration({ id: 'al-15' })} reducedMotion={false} />,
        ),
      );
      expect(layer()?.querySelector('.task-coin:not(.is-rising)')).not.toBeNull();
      clamp();
      expect(track()?.style.transform).toBe('translate(0px, 188px)');
    } finally {
      scrollY.mockRestore();
      height.mockRestore();
    }
  });

  it('starts a creation coin at the new row, or at the add button when the row is off screen', () => {
    const created = celebration({ id: 'al-12', kind: 'created', praise: '' });
    const add = document.createElement('button');
    add.dataset.celebrationFallback = 'task-create';
    placeAt(add, 500, 100);
    document.body.append(add);
    try {
      origin.dataset.celebrationOrigin = 'al-12';
      act(() => root.render(<TaskCoinLayer celebration={created} reducedMotion={false} />));
      const coin = () => layer()?.querySelector<HTMLElement>('.task-coin');
      expect(coin()?.style.getPropertyValue('--coin-x')).toBe('610px');
      act(() => root.render(<></>));
      // The form unmounted and the row is not visible: the coin starts at 添加待办.
      origin.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect;
      act(() =>
        root.render(
          <TaskCoinLayer celebration={{ ...created, id: 'al-13' }} reducedMotion={false} />,
        ),
      );
      expect(coin()?.style.getPropertyValue('--coin-x')).toBe('510px');
      expect(layer()?.querySelector('.task-coin-tag')?.textContent).toBe('+5 元');
      // A completion never borrows the add button: without its check there is no coin.
      act(() =>
        root.render(
          <TaskCoinLayer celebration={celebration({ id: 'al-14' })} reducedMotion={false} />,
        ),
      );
      expect(coin()).toBeNull();
    } finally {
      add.remove();
    }
  });

  it('never restarts a creation flight when the same committed grant re-renders', () => {
    vi.useFakeTimers();
    const animate = vi.fn();
    wallet.animate = animate;
    const created = celebration({ kind: 'created', praise: '' });
    act(() => root.render(<TaskCoinLayer celebration={created} reducedMotion={false} />));
    const first = layer()?.querySelector('.task-coin');
    act(() => root.render(<TaskCoinLayer celebration={{ ...created }} reducedMotion={false} />));
    expect(layer()?.querySelector('.task-coin')).toBe(first);
    act(() =>
      vi.advanceTimersByTime(TASK_CELEBRATION_MS.coinDelay + TASK_CELEBRATION_MS.coinFlight),
    );
    expect(animate).toHaveBeenCalledOnce();
  });
});

describe('todo completion timing', () => {
  let root: Root;
  let container: HTMLDivElement;
  let hidden = false;
  let api: ReturnType<typeof useTaskCelebration> | null = null;
  function Probe() {
    const value = useTaskCelebration();
    useEffect(() => {
      api = value;
    });
    return null;
  }
  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<Probe />));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('clears one moment, and keeps the companion reaction a little longer', () => {
    act(() => api!.celebrate(celebration()));
    expect(api!.current?.id).toBe('al-9');
    expect(api!.reaction?.praise).toBe('你又完成一件啦！');
    act(() => vi.advanceTimersByTime(TASK_CELEBRATION_MS.total - 1));
    expect(api!.current).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(api!.current).toBeNull();
    expect(api!.reaction).not.toBeNull();
    act(() =>
      vi.advanceTimersByTime(TASK_CELEBRATION_MS.companionHold - TASK_CELEBRATION_MS.total),
    );
    expect(api!.reaction).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('carries the completion ordinal fixed at commit on the companion reaction', () => {
    act(() => api!.celebrate(celebration(), { ordinal: 2 }));
    expect(api!.reaction?.ordinal).toBe(2);
    act(() => api!.celebrate(celebration({ id: 'al-10' })));
    expect(api!.reaction?.ordinal).toBe(0);
    act(() => api!.celebrate(celebration({ id: 'al-11' }), { ordinal: Number.NaN }));
    expect(api!.reaction?.ordinal).toBe(0);
    act(() => api!.celebrate(celebration({ id: 'al-12' }), { ordinal: 3.7 }));
    expect(api!.reaction?.ordinal).toBe(3);
  });

  it('lets a newer result replace the previous moment', () => {
    act(() => api!.celebrate(celebration()));
    act(() => vi.advanceTimersByTime(900));
    act(() => api!.celebrate(celebration({ id: 'al-10', taskId: 'other' })));
    act(() => vi.advanceTimersByTime(TASK_CELEBRATION_MS.total - 1));
    expect(api!.current?.id).toBe('al-10');
  });

  it('shows a creation grant without any companion praise', () => {
    act(() => api!.celebrate(celebration({ kind: 'created', praise: '' }), { companion: false }));
    expect(api!.current?.kind).toBe('created');
    expect(api!.reaction).toBeNull();
    act(() => vi.advanceTimersByTime(TASK_CELEBRATION_MS.total));
    expect(api!.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends only the matching moment when its completion is undone', () => {
    act(() => api!.celebrate(celebration()));
    act(() => api!.dismiss('other', '2026-10-24'));
    expect(api!.current?.id).toBe('al-9');
    act(() => api!.dismiss('task', '2026-10-24'));
    expect(api!.current).toBeNull();
    expect(api!.reaction).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never starts while hidden and ends at once when the page hides', () => {
    hidden = true;
    act(() => api!.celebrate(celebration()));
    expect(api!.current).toBeNull();
    hidden = false;
    act(() => api!.celebrate(celebration()));
    hidden = true;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(api!.current).toBeNull();
    expect(api!.reaction).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears every timer on unmount', () => {
    act(() => api!.celebrate(celebration()));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    act(() => root.render(<></>));
    expect(vi.getTimerCount()).toBe(0);
  });
});
