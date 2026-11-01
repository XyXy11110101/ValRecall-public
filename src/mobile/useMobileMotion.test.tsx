import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOBILE_COMPLETION_MS, MOBILE_WALLET_TAB_ID, useMobileMotion } from './useMobileMotion';
import type { MobilePage } from './navigation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Sample({
  page,
  save,
  estimate,
}: {
  page: MobilePage;
  save: () => Promise<boolean>;
  estimate?: number | undefined;
}) {
  const motion = useMobileMotion(page);
  const [done, setDone] = useState(false);
  return (
    <main ref={motion.shell}>
      <div className="mobile-page" hidden={page !== 'tasks'}>
        <ul>
          {!done && (
            <li id="sample-task" className="mobile-task">
              <button
                onClick={async () => {
                  const finish = motion.prepareCompletion('sample-task');
                  if (await save()) {
                    setDone(true);
                    finish(estimate === undefined ? undefined : { estimate });
                  }
                }}
              >
                <span className="mobile-checkbox" />
                完成
              </button>
            </li>
          )}
          <li id="next-task" className="mobile-task">
            下一条
          </li>
        </ul>
      </div>
      <div className="mobile-page" hidden={page !== 'wallet'}>
        钱包
      </div>
      <nav>
        <button id={MOBILE_WALLET_TAB_ID} type="button">
          零花钱
        </button>
      </nav>
    </main>
  );
}

describe('mobile presentation motion', () => {
  let host: HTMLDivElement;
  let root: Root;
  let reduced: boolean;
  let records: {
    target: Element;
    frames: Keyframe[];
    animation: EventTarget & { cancel: ReturnType<typeof vi.fn> };
  }[];
  beforeEach(() => {
    vi.useFakeTimers();
    reduced = false;
    records = [];
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    vi.stubGlobal('matchMedia', () => ({
      matches: reduced,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(0), 16),
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      value: function (this: Element, frames: Keyframe[]) {
        const animation = Object.assign(new EventTarget(), { cancel: vi.fn() });
        records.push({ target: this, frames, animation });
        return animation;
      },
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (Element.prototype as Partial<Element>).animate;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  async function render(page: MobilePage, save: () => Promise<boolean>, estimate?: number) {
    await act(async () => root.render(<Sample page={page} save={save} estimate={estimate} />));
    const wallet = document.getElementById(MOBILE_WALLET_TAB_ID);
    if (wallet)
      wallet.getBoundingClientRect = () =>
        ({ left: 200, top: 780, width: 80, height: 56, right: 280, bottom: 836 }) as DOMRect;
  }
  async function click() {
    await act(async () => host.querySelector('button')!.click());
  }
  async function frame() {
    await act(async () => vi.advanceTimersByTimeAsync(20));
  }

  it('never presents completion before persistence succeeds, then uses an inert visual copy', async () => {
    let resolve!: (value: boolean) => void;
    const save = vi.fn(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    await render('tasks', save);
    await click();
    await frame();
    expect(records).toHaveLength(0);
    expect(document.getElementById('sample-task')).not.toBeNull();
    await act(async () => resolve(true));
    await frame();
    expect(save).toHaveBeenCalledTimes(1);
    expect(document.getElementById('sample-task')).toBeNull();
    const ghost = document.querySelector<HTMLElement>('.mobile-completion-ghost')!;
    expect(ghost.inert).toBe(true);
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    expect(ghost.querySelector('[id]')).toBeNull();
    expect(ghost.querySelector('.mobile-checkbox')?.textContent).toBe('✓');
    records.find((record) => record.target === ghost)!.animation.dispatchEvent(new Event('finish'));
    expect(document.querySelector('.mobile-completion-ghost')).toBeNull();
  });
  it('retains the real row and shows no success animation after a failed save', async () => {
    await render('tasks', async () => false);
    await click();
    await frame();
    expect(document.getElementById('sample-task')).not.toBeNull();
    expect(records).toHaveLength(0);
  });
  it('discards a late completion after leaving and returning to the same page', async () => {
    let resolve!: (value: boolean) => void;
    const save = () =>
      new Promise<boolean>((done) => {
        resolve = done;
      });
    await render('tasks', save);
    await click();
    await render('wallet', save);
    await render('tasks', save);
    await act(async () => resolve(true));
    await frame();
    expect(document.querySelector('.mobile-completion-ghost')).toBeNull();
    expect(records.every((record) => record.target.classList.contains('mobile-page'))).toBe(true);
  });
  it('cleans up transient copies and animations on background without affecting saved state', async () => {
    const save = vi.fn(async () => true);
    await render('tasks', save);
    await click();
    await frame();
    expect(document.querySelector('.mobile-completion-ghost')).not.toBeNull();
    window.dispatchEvent(new Event('valrecall-app-background'));
    expect(document.querySelector('.mobile-completion-ghost')).toBeNull();
    expect(records.every((record) => record.animation.cancel.mock.calls.length === 1)).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(document.getElementById('sample-task')).toBeNull();
  });
  it('changes data and navigates immediately when reduced motion is requested', async () => {
    reduced = true;
    const save = vi.fn(async () => true);
    await render('tasks', save);
    await click();
    await frame();
    await render('wallet', save);
    expect(save).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(0);
    expect(host.querySelector('.mobile-page:not([hidden])')?.textContent).toBe('钱包');
  });
  it('holds the sealed copy before it folds, and flies a hollow estimate coin to the wallet tab', async () => {
    await render('tasks', async () => true, 5);
    await click();
    await frame();
    const ghost = document.querySelector<HTMLElement>('.mobile-completion-ghost')!;
    const fade = records.find((record) => record.target === ghost)!;
    expect(fade.frames.at(-1)).toMatchObject({ opacity: 0 });
    const coin = document.querySelector<HTMLElement>('.mobile-completion-coin.is-pending')!;
    expect(coin.textContent).toBe('+5');
    expect(coin.inert).toBe(true);
    expect(coin.getAttribute('aria-hidden')).toBe('true');
    const wallet = document.getElementById(MOBILE_WALLET_TAB_ID)!;
    expect(records.some((record) => record.target === wallet)).toBe(true);
    window.dispatchEvent(new Event('valrecall-app-background'));
    expect(document.querySelector('.mobile-completion-coin')).toBeNull();
  });
  it('shows no coin without a positive estimate or under reduced motion', async () => {
    await render('tasks', async () => true, 0);
    await click();
    await frame();
    expect(document.querySelector('.mobile-completion-coin')).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    reduced = true;
    await render('tasks', async () => true, 5);
    await click();
    await frame();
    expect(document.querySelector('.mobile-completion-coin')).toBeNull();
    expect(
      records.filter((record) => record.target.classList.contains('mobile-completion-coin')),
    ).toHaveLength(0);
  });
  it('pops one filled coin on the wallet tab when the computer confirms', async () => {
    let celebrate!: (label: string) => void;
    function Confirmation() {
      const motion = useMobileMotion('tasks');
      celebrate = motion.celebrateConfirmation;
      return (
        <main ref={motion.shell}>
          <button id={MOBILE_WALLET_TAB_ID} type="button">
            零花钱
          </button>
        </main>
      );
    }
    await act(async () => root.render(<Confirmation />));
    document.getElementById(MOBILE_WALLET_TAB_ID)!.getBoundingClientRect = () =>
      ({ left: 200, top: 780, width: 80, height: 56, right: 280, bottom: 836 }) as DOMRect;
    act(() => celebrate('+5'));
    const coin = document.querySelector<HTMLElement>('.mobile-completion-coin.is-confirmed')!;
    expect(coin.inert).toBe(true);
    expect(coin.textContent).toBe('+5');
    records.find((record) => record.target === coin)!.animation.dispatchEvent(new Event('finish'));
    expect(document.querySelector('.mobile-completion-coin')).toBeNull();
    expect(MOBILE_COMPLETION_MS.hold).toBeGreaterThanOrEqual(MOBILE_COMPLETION_MS.seal);
    // The copy covers the row that glides into its slot, so it must leave quickly.
    expect(MOBILE_COMPLETION_MS.hold + MOBILE_COMPLETION_MS.fade).toBeLessThanOrEqual(400);
  });

  describe('a task saved on the phone', () => {
    let celebrate!: (rowId: string, label: string) => void;
    function Creation({ page, future = false }: { page: MobilePage; future?: boolean }) {
      const motion = useMobileMotion(page);
      celebrate = motion.celebrateCreation;
      return (
        <main ref={motion.shell}>
          <div className="mobile-page" hidden={page !== 'tasks'}>
            {future ? (
              <details className="mobile-future">
                <summary>之后</summary>
                <ul>
                  <li id="mobile-task-new" className="mobile-task">
                    以后
                  </li>
                </ul>
              </details>
            ) : (
              <ul>
                <li id="mobile-task-new" className="mobile-task">
                  <span className="mobile-checkbox" />
                  新任务
                </li>
              </ul>
            )}
          </div>
          <nav hidden={page !== 'tasks' && page !== 'wallet'}>
            <button id={MOBILE_WALLET_TAB_ID} type="button">
              零花钱
            </button>
          </nav>
        </main>
      );
    }
    async function show(page: MobilePage, future = false) {
      await act(async () => root.render(<Creation page={page} future={future} />));
      document.getElementById(MOBILE_WALLET_TAB_ID)!.getBoundingClientRect = () =>
        ({ left: 200, top: 780, width: 80, height: 56, right: 280, bottom: 836 }) as DOMRect;
      const check = document.querySelector<HTMLElement>('#mobile-task-new .mobile-checkbox');
      if (check)
        check.getBoundingClientRect = () =>
          ({ left: 30, top: 300, width: 20, height: 20, right: 50, bottom: 320 }) as DOMRect;
    }
    const coins = () => [...document.querySelectorAll<HTMLElement>('.mobile-completion-coin')];

    it('flies one hollow estimate coin from the new row checkbox to the wallet tab', async () => {
      await show('tasks');
      act(() => celebrate('mobile-task-new', '+5'));
      expect(coins()).toHaveLength(1);
      const coin = coins()[0]!;
      expect(coin.classList.contains('is-pending')).toBe(true);
      expect(coin.textContent).toBe('+5');
      expect(coin.inert).toBe(true);
      expect(coin.getAttribute('aria-hidden')).toBe('true');
      expect(coin.style.left).toBe('40px');
      expect(coin.style.top).toBe('310px');
      const flight = records.find((record) => record.target === coin)!;
      // The coin travels to the wallet tab centre: (240, 808) from (40, 310).
      expect(String(flight.frames.at(-1)?.transform)).toContain('translate(200px, 498px)');
      // Leaving the page cancels it with every other transient.
      await show('wallet');
      expect(coins()).toHaveLength(0);
    });

    it('pops the coin on the wallet tab when the new row is out of sight', async () => {
      await show('tasks', true);
      act(() => celebrate('mobile-task-new', '+5'));
      expect(coins()).toHaveLength(1);
      expect(coins()[0]!.style.left).toBe('240px');
      expect(coins()[0]!.classList.contains('is-pending')).toBe(true);
    });

    it('draws nothing on a subpage, while hidden or under reduced motion', async () => {
      await show('add-task');
      act(() => celebrate('mobile-task-new', '+5'));
      expect(coins()).toHaveLength(0);
      await show('tasks');
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      act(() => celebrate('mobile-task-new', '+5'));
      expect(coins()).toHaveLength(0);
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      reduced = true;
      act(() => celebrate('mobile-task-new', '+5'));
      expect(coins()).toHaveLength(0);
      expect(
        records.some((record) => record.target.classList.contains('mobile-completion-coin')),
      ).toBe(false);
    });
  });
});
