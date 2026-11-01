import { useEffect, useLayoutEffect, useRef } from 'react';
import { isSubpage, type MobilePage } from './navigation';

/**
 * The finished copy seals over its old slot, then fades almost at once: the rows below glide
 * up beneath it, so a long hold would cover the next task.
 */
export const MOBILE_COMPLETION_MS = {
  seal: 200,
  hold: 220,
  fade: 160,
  coinDelay: 120,
  coinFlight: 600,
  bump: 360,
  confirm: 500,
} as const;

export const MOBILE_WALLET_TAB_ID = 'mobile-nav-wallet';

/** Presentation only: persistence and navigation never wait for an animation. */
export function useMobileMotion(page: MobilePage) {
  const shell = useRef<HTMLElement>(null);
  const previous = useRef(page);
  const generation = useRef(0);
  const animations = useRef(new Set<Animation>());
  const ghosts = useRef(new Set<HTMLElement>());
  const frame = useRef<number | null>(null);

  function allowed() {
    return (
      document.visibilityState !== 'hidden' &&
      !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    );
  }
  function clear() {
    generation.current++;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    animations.current.forEach((animation) => animation.cancel());
    animations.current.clear();
    ghosts.current.forEach((ghost) => ghost.remove());
    ghosts.current.clear();
  }
  function play(
    element: Element,
    frames: Keyframe[],
    duration: number,
    easing = 'cubic-bezier(.2,.7,.2,1)',
    timing: { delay?: number; fill?: FillMode } = {},
  ) {
    if (!allowed() || typeof element.animate !== 'function') return;
    const animation = element.animate(frames, { duration, easing, ...timing });
    animations.current.add(animation);
    const done = () => animations.current.delete(animation);
    animation.addEventListener('finish', done, { once: true });
    animation.addEventListener('cancel', done, { once: true });
    return animation;
  }

  useLayoutEffect(() => {
    if (previous.current === page) return;
    const from = previous.current;
    previous.current = page;
    clear();
    const target = shell.current?.querySelector('.mobile-page:not([hidden])');
    if (target) {
      const distance = isSubpage(page) ? 16 : isSubpage(from) ? -12 : 0;
      play(
        target,
        [
          { opacity: 0, transform: `translateX(${distance}px)` },
          { opacity: 1, transform: 'translateX(0)' },
        ],
        distance ? 200 : 140,
      );
    }
  }, [page]);

  useEffect(() => {
    const root = shell.current;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let pressed: HTMLButtonElement | null = null;
    let pressAnimation: Animation | undefined;
    const press = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target.closest('button') : null;
      if (!target || target.disabled || target.classList.contains('mobile-notes')) return;
      pressAnimation?.cancel();
      pressed = target;
      pressAnimation = play(target, [{ transform: 'scale(1)' }, { transform: 'scale(.98)' }], 90);
    };
    const release = () => {
      pressAnimation?.cancel();
      if (pressed?.isConnected && !pressed.closest('[hidden]'))
        play(
          pressed,
          [
            { transform: 'scale(.98)' },
            { transform: 'scale(1.006)', offset: 0.7 },
            { transform: 'scale(1)' },
          ],
          180,
        );
      pressed = null;
    };
    const stop = () => {
      pressed = null;
      clear();
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') stop();
    };
    root?.addEventListener('pointerdown', press);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('valrecall-app-background', stop);
    document.addEventListener('visibilitychange', visibility);
    reduced?.addEventListener('change', stop);
    return () => {
      root?.removeEventListener('pointerdown', press);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('valrecall-app-background', stop);
      document.removeEventListener('visibilitychange', visibility);
      reduced?.removeEventListener('change', stop);
      clear();
    };
  }, []);

  /** A decorative coin outside the flow: inert, hidden from assistive tech, removed on cleanup. */
  function flyCoin(
    from: { x: number; y: number },
    target: HTMLElement,
    label: string,
    kind: 'pending' | 'confirmed',
  ) {
    const to = target.getBoundingClientRect();
    if (!to.width || !to.height) return;
    const dx = to.left + to.width / 2 - from.x;
    const dy = to.top + to.height / 2 - from.y;
    const coin = document.createElement('span');
    coin.className = `mobile-completion-coin is-${kind}`;
    coin.textContent = label;
    coin.inert = true;
    coin.setAttribute('aria-hidden', 'true');
    Object.assign(coin.style, { left: `${from.x}px`, top: `${from.y}px` });
    document.body.append(coin);
    ghosts.current.add(coin);
    const remove = () => {
      coin.remove();
      ghosts.current.delete(coin);
    };
    const at = (t: number, lift: number) => `translate(${dx * t}px, ${dy * t - lift}px)`;
    const animation = play(
      coin,
      [
        { opacity: 0, transform: `${at(0, 0)} scale(.6)` },
        { opacity: 1, transform: `${at(0.25, 36)} scale(1.05)`, offset: 0.25 },
        { opacity: 1, transform: `${at(0.6, 40)} scale(1)`, offset: 0.6 },
        { opacity: 1, transform: `${at(0.9, 12)} scale(.9)`, offset: 0.9 },
        { opacity: 0, transform: `${at(1, 0)} scale(.7)` },
      ],
      MOBILE_COMPLETION_MS.coinFlight,
      'linear',
      { delay: MOBILE_COMPLETION_MS.coinDelay, fill: 'backwards' },
    );
    if (animation) animation.addEventListener('finish', remove, { once: true });
    else remove();
    play(
      target,
      [{ transform: 'none' }, { transform: 'scale(1.12)', offset: 0.45 }, { transform: 'none' }],
      MOBILE_COMPLETION_MS.bump,
      'cubic-bezier(.2,.8,.2,1)',
      { delay: MOBILE_COMPLETION_MS.coinDelay + MOBILE_COMPLETION_MS.coinFlight },
    );
  }

  /** The computer confirmed saved completions: one filled coin pops on the wallet tab. */
  function celebrateConfirmation(label: string) {
    if (!allowed()) return;
    const target = document.getElementById(MOBILE_WALLET_TAB_ID);
    if (!target || target.closest('[hidden]')) return;
    popCoin(target, label, 'confirmed');
  }

  /**
   * A task saved on the phone: a hollow estimate coin flies from the new row's checkbox to
   * the wallet tab. Only on the main tasks page; a row that is not visible (a collapsed
   * future list) pops the coin on the wallet tab instead. Synchronous, so a page change or
   * background cleanup that follows cancels it with every other transient.
   */
  function celebrateCreation(rowId: string, label: string) {
    if (!allowed() || previous.current !== 'tasks') return;
    const wallet = document.getElementById(MOBILE_WALLET_TAB_ID);
    if (!wallet || wallet.closest('[hidden]')) return;
    const row = document.getElementById(rowId);
    const check = row && !row.closest('[hidden]') ? row.querySelector('.mobile-checkbox') : null;
    const rect = (check ?? row)?.getBoundingClientRect();
    const visible =
      rect &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      !row?.closest('details:not([open])');
    if (rect && visible)
      flyCoin(
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        wallet,
        label,
        'pending',
      );
    else popCoin(wallet, label, 'pending');
  }

  /** One coin rising off the wallet tab: no origin row is on screen. */
  function popCoin(target: HTMLElement, label: string, kind: 'pending' | 'confirmed') {
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const coin = document.createElement('span');
    coin.className = `mobile-completion-coin is-${kind}`;
    coin.textContent = label;
    coin.inert = true;
    coin.setAttribute('aria-hidden', 'true');
    Object.assign(coin.style, {
      left: `${rect.left + rect.width / 2}px`,
      top: `${rect.top}px`,
    });
    document.body.append(coin);
    ghosts.current.add(coin);
    const remove = () => {
      coin.remove();
      ghosts.current.delete(coin);
    };
    const animation = play(
      coin,
      [
        { opacity: 0, transform: 'translateY(4px) scale(.6)' },
        { opacity: 1, transform: 'translateY(-8px) scale(1.1)', offset: 0.4 },
        { opacity: 0, transform: 'translateY(-12px) scale(1)' },
      ],
      MOBILE_COMPLETION_MS.confirm,
    );
    if (animation) animation.addEventListener('finish', remove, { once: true });
    else remove();
    play(
      target,
      [{ transform: 'none' }, { transform: 'scale(1.12)', offset: 0.45 }, { transform: 'none' }],
      MOBILE_COMPLETION_MS.bump,
    );
  }

  function prepareCompletion(id: string) {
    const root = shell.current;
    const row = document.getElementById(id);
    if (!root || !row || !allowed() || typeof row.animate !== 'function') return () => {};
    const ticket = generation.current;
    const bounds = row.getBoundingClientRect();
    const check = row.querySelector('.mobile-checkbox')?.getBoundingClientRect() ?? bounds;
    const origin = { x: check.left + check.width / 2, y: check.top + check.height / 2 };
    const scroll = window.scrollY;
    const clone = row.cloneNode(true) as HTMLElement;
    const positions = new Map(
      [...root.querySelectorAll<HTMLElement>('.mobile-page:not([hidden]) .mobile-task')].map(
        (element) => [element.id, element.getBoundingClientRect().top],
      ),
    );
    // Called only after a successful local write. No handlers, IDs or focusable duplicate content.
    // The estimate may arrive slightly later; a stale or backgrounded page never shows the coin.
    return ({ estimate }: { estimate?: number | Promise<number> } = {}) => {
      if (ticket !== generation.current || !allowed()) return;
      void Promise.resolve(estimate ?? 0).then((amount) => {
        if (amount <= 0 || ticket !== generation.current || scroll !== window.scrollY) return;
        const wallet = document.getElementById(MOBILE_WALLET_TAB_ID);
        if (wallet && !wallet.closest('[hidden]')) flyCoin(origin, wallet, `+${amount}`, 'pending');
      });
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        if (ticket !== generation.current || !allowed() || scroll !== window.scrollY) return;
        clone.removeAttribute('id');
        clone.removeAttribute('tabindex');
        clone.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
        clone.inert = true;
        clone.setAttribute('aria-hidden', 'true');
        clone.classList.add('mobile-completion-ghost');
        Object.assign(clone.style, {
          left: `${bounds.left}px`,
          top: `${bounds.top}px`,
          width: `${bounds.width}px`,
          height: `${bounds.height}px`,
        });
        const checkbox = clone.querySelector('.mobile-checkbox');
        if (checkbox) checkbox.textContent = '✓';
        document.body.append(clone);
        ghosts.current.add(clone);
        if (checkbox)
          play(
            checkbox,
            [
              { transform: 'scale(.6)' },
              { transform: 'scale(1.12)', offset: 0.55 },
              { transform: 'none' },
            ],
            MOBILE_COMPLETION_MS.seal,
          );
        const animation = play(
          clone,
          [
            { opacity: 1, transform: 'none' },
            { opacity: 0, transform: 'translateY(-6px)' },
          ],
          MOBILE_COMPLETION_MS.fade,
          undefined,
          { delay: MOBILE_COMPLETION_MS.hold, fill: 'backwards' },
        );
        const remove = () => {
          clone.remove();
          ghosts.current.delete(clone);
        };
        if (animation) animation.addEventListener('finish', remove, { once: true });
        else remove();
        root
          .querySelectorAll<HTMLElement>('.mobile-page:not([hidden]) .mobile-task')
          .forEach((element) => {
            const before = positions.get(element.id);
            if (before === undefined) return;
            const delta = before - element.getBoundingClientRect().top;
            if (delta)
              play(
                element,
                [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
                200,
              );
          });
      });
    };
  }
  return { shell, prepareCompletion, celebrateConfirmation, celebrateCreation };
}
