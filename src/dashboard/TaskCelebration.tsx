import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

import { TASK_CELEBRATION_MS, type TaskCelebration } from '../shared/task-celebration';
import './task-feedback.css';

interface Point {
  x: number;
  y: number;
}

interface Flight {
  id: string;
  amount: number;
  from: Point | null;
  to: Point | null;
  /** The page offset at measurement; the coin follows any later page scroll. */
  scroll: Point;
}

/**
 * Decorative only: the committed receipt is already shown in text. The coin layer sits
 * outside the document flow, so it can never move content or take focus or input.
 */
export function TaskCoinLayer({
  celebration,
  reducedMotion,
}: {
  celebration: TaskCelebration | null;
  reducedMotion: boolean;
}) {
  const [flight, setFlight] = useState<Flight | null>(null);
  const track = useRef<HTMLDivElement | null>(null);
  const id = celebration?.id ?? null;
  const amount = celebration?.amount ?? 0;

  useLayoutEffect(() => {
    if (!id || amount <= 0) {
      setFlight(null);
      return;
    }
    const from = visibleCenter(
      celebrationOrigin(
        id,
        `${celebration?.taskId}:${celebration?.localDate}`,
        celebration?.kind === 'created',
      ),
    );
    const target = nearestWalletTarget(from);
    setFlight({
      id,
      amount,
      from,
      to: target ? centerOf(target) : null,
      scroll: { x: window.scrollX, y: window.scrollY },
    });
    if (!target || reducedMotion || typeof target.animate !== 'function') return;
    const bump = window.setTimeout(() => {
      target.animate([{ transform: 'none' }, { transform: 'scale(1.22)' }, { transform: 'none' }], {
        duration: TASK_CELEBRATION_MS.walletBump,
        easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      });
    }, TASK_CELEBRATION_MS.coinDelay + TASK_CELEBRATION_MS.coinFlight);
    return () => window.clearTimeout(bump);
  }, [id, amount, reducedMotion]);

  useEffect(() => {
    if (!flight) return;
    // The coin was measured in viewport coordinates. When the page scrolls afterwards, the
    // track moves with the content, so the coin keeps flying to its wallet instead of
    // drifting or vanishing. One exception: a coin with no wallet to reach shows its amount
    // in place, and a shorter page (the finished row left the list) only clamps the offset,
    // which would carry that amount out of view, so it stays where the reader saw it.
    let last = flight.scroll;
    let dx = 0;
    let dy = 0;
    const rising = flight.to === null;
    const follow = () => {
      const node = track.current;
      if (!node) return;
      const now = { x: window.scrollX, y: window.scrollY };
      const bottom = document.documentElement.scrollHeight - window.innerHeight;
      const clamped = now.y < last.y && Math.abs(now.y - bottom) <= 1;
      if (!(rising && clamped)) {
        dx -= now.x - last.x;
        dy -= now.y - last.y;
      }
      last = now;
      node.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : '';
    };
    follow();
    window.addEventListener('scroll', follow, { passive: true });
    return () => window.removeEventListener('scroll', follow);
  }, [flight]);

  if (!flight || !celebration || flight.id !== celebration.id) return null;
  const { from, to } = flight;
  // Without a visible wallet the amount is shown where the coin starts.
  const tagAt = to ?? from;
  if (!tagAt) return null;
  const label = `+${flight.amount} 元`;
  return createPortal(
    <div className="task-coin-layer" aria-hidden="true" inert>
      <div className="task-coin-track" ref={track}>
        {from && !reducedMotion && (
          <span
            className={`task-coin${to ? '' : ' is-rising'}`}
            style={
              {
                '--coin-x': `${from.x}px`,
                '--coin-y': `${from.y}px`,
                '--coin-dx': `${to ? to.x - from.x : 0}px`,
                '--coin-dy': `${to ? to.y - from.y : 0}px`,
              } as CSSProperties
            }
          >
            <span className="task-coin-x">
              <span className="task-coin-y">
                <span className="task-coin-lift">
                  <span className="task-coin-face">+{flight.amount}</span>
                </span>
              </span>
            </span>
          </span>
        )}
        <span
          className={`task-coin-tag${reducedMotion ? ' is-static' : ''}${to ? '' : ' at-origin'}`}
          style={{ '--tag-x': `${tagAt.x}px`, '--tag-y': `${tagAt.y - 18}px` } as CSSProperties}
        >
          {label}
        </span>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The visible check of the finished occurrence, or the receipt-bound mark (the Tasks page
 * seal, or a just-created row). A creation whose row is not visible starts from the
 * always-mounted 添加待办 button instead; a completion never does.
 */
function celebrationOrigin(id: string, key: string, created: boolean): Element | null {
  const visible = (selector: string, matches: (element: HTMLElement) => boolean) =>
    [...document.querySelectorAll<HTMLElement>(selector)].find(
      (element) => matches(element) && visibleCenter(element),
    );
  return (
    visible('[data-celebration-key]', (element) => element.dataset.celebrationKey === key) ??
    visible('[data-celebration-origin]', (element) => element.dataset.celebrationOrigin === id) ??
    (created
      ? visible('[data-celebration-fallback]', (element) =>
          Boolean(element.dataset.celebrationFallback),
        )
      : undefined) ??
    null
  );
}

/** The closest visible wallet number; hidden or off-screen targets are ignored. */
function nearestWalletTarget(from: Point | null): HTMLElement | null {
  let best: { element: HTMLElement; distance: number } | null = null;
  for (const element of document.querySelectorAll<HTMLElement>('[data-wallet-target]')) {
    const center = visibleCenter(element);
    if (!center) continue;
    const distance = from ? Math.hypot(center.x - from.x, center.y - from.y) : 0;
    if (!best || distance < best.distance) best = { element, distance };
  }
  return best?.element ?? null;
}

function visibleCenter(element: Element | null): Point | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  if (rect.bottom <= 0 || rect.right <= 0) return null;
  if (rect.top >= window.innerHeight || rect.left >= window.innerWidth) return null;
  return centerOf(element);
}

function centerOf(element: Element): Point {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}
