import { useLayoutEffect, useReducer, useRef } from 'react';
import { flushSync } from 'react-dom';

import type { ViewTransitionLike } from '../ui/motion';

/** On `<html>` for as long as a flip runs, set to its direction: every rule hangs off this. */
export const WORKING_FLIP_ATTRIBUTE = 'data-working-flip';
/** Added once the new page is in, whose snapshot leaves the cards' boxes to the transition. */
export const WORKING_FLIP_NEW_ATTRIBUTE = 'data-working-flip-new';
/** Added when the page was scrolled, so the sticky sidebar may shift and has to move with it. */
export const WORKING_FLIP_SCROLLED_ATTRIBUTE = 'data-working-flip-scrolled';
/** The parts of the one row that travels between the list and the card. */
const WORKING_FLIP_TITLE_NAME = 'working-flip-title';
const WORKING_FLIP_CHECK_NAME = 'working-flip-check';
/** The two boxes that change shape. Their contents stay put on screen while each one moves. */
const WORKING_FLIP_BOXES = {
  tasks: '.home-tasks-card',
  review: '.home-today, .home-review-strip',
} as const;
/** The browser calls back within a frame or two. A page it never draws must not wait for that. */
export const WORKING_FLIP_COMMIT_TIMEOUT_MS = 800;
/** Until then the new page is too faint to aim at, and the old one has only just gone. */
export const WORKING_FLIP_NEW_PAGE_READABLE_MS = 180;
const WORKING_FLIP_CONTROLS = 'button, a[href], summary, input, textarea, select';
/** A press that moves further than this before its release is a drag, not a click. */
const WORKING_FLIP_CLICK_SLOP_PX = 8;

export interface WorkingDisplay {
  layout: boolean;
  /** The task on the card, as `data-occurrence` ends: the row that morphs. */
  rowKey: string | null;
}

interface PendingFlip {
  cancel(): void;
}

interface FlipControl {
  element: HTMLElement;
  name: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface RunningFlip {
  transition: ViewTransitionLike | undefined;
  /** What the page offered, and where, when the flip began. */
  controlsBefore: FlipControl[];
  /** Null until the new page is in and playing. */
  readyAt: number | null;
}

type StartViewTransition = (update: () => void) => ViewTransitionLike | undefined;

function viewTransitionApi(): StartViewTransition | null {
  const start = (document as { startViewTransition?: unknown }).startViewTransition;
  return typeof start === 'function' ? (start.bind(document) as StartViewTransition) : null;
}

/**
 * The row on screen for this task: the list's or the card's, never the finished one further down.
 * A row clipped by the list's own scroller, or off the page, stays with the rest of the card: its
 * snapshot would fly in over whatever is covering it.
 */
function visibleRow(rowKey: string): HTMLElement | null {
  const row = [
    ...document.querySelectorAll<HTMLElement>('.home-tasks-card [data-occurrence]'),
  ].find(
    (candidate) =>
      candidate.dataset.occurrence?.endsWith(`:${rowKey}`) &&
      candidate.dataset.group !== 'completed' &&
      !candidate.closest('[hidden]'),
  );
  if (!row) return null;
  const box = row.getBoundingClientRect();
  const scroller = row.closest('.home-task-scroll')?.getBoundingClientRect();
  const top = Math.max(0, scroller?.top ?? 0);
  const bottom = Math.min(window.innerHeight, scroller?.bottom ?? window.innerHeight);
  return box.top >= top - 1 && box.bottom <= bottom + 1 ? row : null;
}

type FlipBox = keyof typeof WORKING_FLIP_BOXES;
const FLIP_BOX_NAMES = Object.keys(WORKING_FLIP_BOXES) as FlipBox[];

function flipBoxRect(name: FlipBox): DOMRect | undefined {
  return document.querySelector(WORKING_FLIP_BOXES[name])?.getBoundingClientRect();
}

/** Every control a click could reach, by where layout has it: a flip paints elsewhere for a while. */
function flipControls(): FlipControl[] {
  return [...document.querySelectorAll<HTMLElement>(WORKING_FLIP_CONTROLS)].flatMap((element) => {
    if (element.matches(':disabled') || element.closest('[inert]')) return [];
    const box = element.getBoundingClientRect();
    const scroller = element.closest('.home-task-scroll')?.getBoundingClientRect();
    const top = Math.max(box.top, scroller?.top ?? box.top);
    const bottom = Math.min(box.bottom, scroller?.bottom ?? box.bottom);
    // A collapsed list has no box at all, and a row scrolled out of its list has none left.
    if (!(box.right > box.left && bottom > top)) return [];
    const name = element.getAttribute('aria-label') || element.id || element.textContent || '';
    return [{ element, name, left: box.left, right: box.right, top, bottom }];
  });
}

function controlAt(controls: FlipControl[], x: number, y: number): FlipControl | undefined {
  return controls
    .filter(
      (control) =>
        control.left <= x && x <= control.right && control.top <= y && y <= control.bottom,
    )
    .at(-1);
}

/**
 * What a press during a flip was meant for. A row that moved keeps its click: what the user saw
 * there when the flip began wins if it is still on the page. Otherwise it is what is there now,
 * once that can be read. Two different candidates are a guess, and so is finishing a task nobody
 * could have aimed at yet, so those do nothing: a lost click costs less than a wrong one.
 */
function aimOfPress(flip: RunningFlip, readyAt: number, x: number, y: number): HTMLElement | null {
  const controls = flipControls();
  const seen = controlAt(flip.controlsBefore, x, y);
  const twins = seen ? controls.filter((control) => control.name === seen.name) : [];
  const twin = twins.length === 1 ? twins[0]!.element : null;
  if (performance.now() - readyAt < WORKING_FLIP_NEW_PAGE_READABLE_MS) return twin;
  const there = controlAt(controls, x, y)?.element ?? null;
  if (twin) return !there || there === twin ? twin : null;
  return there?.matches('.home-task-check') ? null : there;
}

/**
 * The browser does not hit-test a named element or anything inside it, so a press on either card
 * or on a scrolled sidebar lands on the page underneath, and the browser's click with it. It must
 * not take focus off the new card or start selecting text, and it clicks its real target on
 * release. The second click of a double-click is not a second decision, and stops here.
 */
function pressDuringFlip(event: MouseEvent, flip: RunningFlip | null) {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('.dashboard-sidebar')) return;
  event.preventDefault();
  if (!flip || flip.readyAt === null || event.button !== 0 || event.detail > 1) return;
  if (target?.closest(WORKING_FLIP_CONTROLS)) return;
  const aim = aimOfPress(flip, flip.readyAt, event.clientX, event.clientY);
  if (!aim) return;
  window.addEventListener(
    'mouseup',
    (release) => {
      const moved = Math.hypot(release.clientX - event.clientX, release.clientY - event.clientY);
      if (moved > WORKING_FLIP_CLICK_SLOP_PX || !aim.isConnected) return;
      aim.focus({ preventScroll: true });
      aim.click();
    },
    { capture: true, once: true },
  );
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * Keeps what Home shows separate from what is true, so the page can animate between its normal and
 * working layouts from one place, whatever caused the change: 开始, 先放下, the end of a finished
 * card's moment, or another tab. When `layout` turns over, the render goes on showing the previous
 * display, in full, until the browser has its picture of that page. Only then does the new display
 * commit, inside the transition's callback.
 *
 * Everything that would not animate passes straight through in the same render: reduced motion, no
 * API, a hidden page, and the first read of the page, while `settled` is false.
 */
export function useWorkingLayoutTransition<T extends WorkingDisplay>(
  truth: T,
  { settled, reducedMotion }: { settled: boolean; reducedMotion: boolean },
): { shown: T; flipping: boolean } {
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const latest = useRef(truth);
  latest.current = truth;
  const committed = useRef(truth);
  const wasSettled = useRef(settled);
  const pending = useRef<PendingFlip | null>(null);
  // The running transition, from its start until it has played out.
  const running = useRef<RunningFlip | null>(null);
  const onPress = useRef((event: MouseEvent) => pressDuringFlip(event, running.current)).current;
  const namedParts = useRef<HTMLElement[]>([]);

  const nameRow = (rowKey: string | null) => {
    for (const part of namedParts.current) part.style.removeProperty('view-transition-name');
    namedParts.current = [];
    const row = rowKey === null ? null : visibleRow(rowKey);
    const check = row?.querySelector<HTMLElement>('.home-task-check');
    const title = row?.querySelector<HTMLElement>('.home-task-content strong');
    // A title on one line scales evenly into its new size. One that wraps would stretch, so that row
    // cross-fades with the card, and its check does not go off on its own.
    if (!check || !title || title.getClientRects().length > 1) return;
    check.style.setProperty('view-transition-name', WORKING_FLIP_CHECK_NAME);
    title.style.setProperty('view-transition-name', WORKING_FLIP_TITLE_NAME);
    namedParts.current = [check, title];
  };
  const stopRunning = () => {
    running.current = null;
    nameRow(null);
    document.removeEventListener('mousedown', onPress, true);
    document.documentElement.removeAttribute(WORKING_FLIP_ATTRIBUTE);
    document.documentElement.removeAttribute(WORKING_FLIP_NEW_ATTRIBUTE);
    document.documentElement.removeAttribute(WORKING_FLIP_SCROLLED_ATTRIBUTE);
    for (const name of FLIP_BOX_NAMES) {
      document.documentElement.style.removeProperty(`--working-flip-${name}-x`);
      document.documentElement.style.removeProperty(`--working-flip-${name}-y`);
    }
  };

  const animates =
    settled &&
    wasSettled.current &&
    !reducedMotion &&
    document.visibilityState === 'visible' &&
    viewTransitionApi() !== null;
  const flip = truth.layout !== committed.current.layout;
  const shown = flip && (pending.current !== null || animates) ? committed.current : truth;

  useLayoutEffect(() => {
    wasSettled.current = settled;
    committed.current = shown;
    if (shown.layout === truth.layout) {
      // It turned back before the browser got to it: nothing is left to animate.
      pending.current?.cancel();
      return;
    }
    if (pending.current) return;

    const rowKey = truth.rowKey ?? shown.rowKey;
    let settledFlip = false;
    const finishWaiting = () => {
      if (settledFlip) return false;
      settledFlip = true;
      window.clearTimeout(timer);
      pending.current = null;
      committed.current = latest.current;
      return true;
    };
    const commit = () => {
      if (!finishWaiting()) return;
      document.documentElement.setAttribute(WORKING_FLIP_NEW_ATTRIBUTE, '');
      flushSync(redraw);
      // A row that had nothing to travel from must not appear on its own, above a card still arriving.
      nameRow(namedParts.current.length > 0 ? rowKey : null);
    };

    const own: RunningFlip = {
      transition: undefined,
      controlsBefore: flipControls(),
      readyAt: null,
    };
    const before = FLIP_BOX_NAMES.map((name) => [name, flipBoxRect(name)] as const);
    running.current = own;
    document.addEventListener('mousedown', onPress, true);
    document.documentElement.setAttribute(WORKING_FLIP_ATTRIBUTE, truth.layout ? 'into' : 'back');
    document.documentElement.removeAttribute(WORKING_FLIP_NEW_ATTRIBUTE);
    document.documentElement.toggleAttribute(WORKING_FLIP_SCROLLED_ATTRIBUTE, window.scrollY > 0);
    nameRow(rowKey);
    const timer = window.setTimeout(() => {
      commit();
      own.transition?.skipTransition();
    }, WORKING_FLIP_COMMIT_TIMEOUT_MS);
    pending.current = {
      // The page already shows the truth, or is gone. The callback may still come, to nothing.
      cancel() {
        finishWaiting();
        own.transition?.skipTransition();
      },
    };

    const end = () => {
      if (running.current === own) stopRunning();
    };
    try {
      own.transition = viewTransitionApi()?.(commit);
      if (!own.transition) throw new Error('no transition');
    } catch {
      // Still in this effect, so the redraw lands before anything is painted.
      if (finishWaiting()) redraw();
      end();
      return;
    }
    // Both pages are measured by now, and nothing has been painted yet. The focus code has also had
    // its say about the scroll position, which is why this does not wait for the commit alone.
    void own.transition.ready
      .then(() => {
        if (running.current !== own) return;
        own.readyAt = performance.now();
        for (const [name, from] of before) {
          const to = flipBoxRect(name);
          // A box that leaves its old place altogether, as when the page scrolls a long way, would
          // arrive empty if its contents waited for it there. They travel with it instead.
          if (!from || !to || !overlaps(from, to)) continue;
          const { style } = document.documentElement;
          style.setProperty(`--working-flip-${name}-x`, `${from.left - to.left}px`);
          style.setProperty(`--working-flip-${name}-y`, `${from.top - to.top}px`);
        }
      })
      .catch(() => undefined);
    void own.transition.updateCallbackDone.catch(() => undefined);
    void own.transition.finished.catch(() => undefined).then(end);
  });

  // A route change must not animate, and the page it leaves has nothing left to commit to.
  useLayoutEffect(
    () => () => {
      pending.current?.cancel();
      running.current?.transition?.skipTransition();
      if (running.current) stopRunning();
    },
    [],
  );

  return { shown, flipping: shown.layout !== truth.layout };
}
