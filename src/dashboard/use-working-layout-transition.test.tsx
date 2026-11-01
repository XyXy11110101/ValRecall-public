import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WORKING_FLIP_ATTRIBUTE,
  WORKING_FLIP_COMMIT_TIMEOUT_MS,
  WORKING_FLIP_NEW_ATTRIBUTE,
  WORKING_FLIP_NEW_PAGE_READABLE_MS,
  WORKING_FLIP_SCROLLED_ATTRIBUTE,
  useWorkingLayoutTransition,
  type WorkingDisplay,
} from './use-working-layout-transition';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Display extends WorkingDisplay {
  stamp: string;
}

const NORMAL: Display = { layout: false, rowKey: null, stamp: 'none' };
const WORKING: Display = { layout: true, rowKey: 'a:2026-10-31', stamp: 'none' };

/** A browser that has taken the old picture only when the test says so. */
function stubTransitions() {
  const flips: Array<{
    update: () => void;
    skipTransition: ReturnType<typeof vi.fn>;
    finish: () => void;
  }> = [];
  const startViewTransition = vi.fn((update: () => void) => {
    let finish = () => undefined as void;
    const finished = new Promise<void>((done) => {
      finish = done;
    });
    const skipTransition = vi.fn();
    flips.push({ update, skipTransition, finish: () => finish() });
    return {
      ready: Promise.resolve(),
      updateCallbackDone: Promise.resolve(),
      finished,
      skipTransition,
    };
  });
  Object.assign(document, { startViewTransition });
  return { flips, startViewTransition };
}

const hasFlipAttributes = () =>
  [WORKING_FLIP_ATTRIBUTE, WORKING_FLIP_NEW_ATTRIBUTE, WORKING_FLIP_SCROLLED_ATTRIBUTE].some(
    (name) => document.documentElement.hasAttribute(name),
  );

describe('useWorkingLayoutTransition', () => {
  let container: HTMLDivElement;
  let root: Root;
  let renders: Display[];
  let flippingAt: boolean[];

  function Probe({
    truth,
    settled = true,
    reducedMotion = false,
  }: {
    truth: Display;
    settled?: boolean;
    reducedMotion?: boolean;
  }) {
    const { shown, flipping } = useWorkingLayoutTransition(truth, { settled, reducedMotion });
    renders.push(shown);
    flippingAt.push(flipping);
    return (
      <div id="page" data-layout={String(shown.layout)} data-stamp={shown.stamp}>
        <ol className="home-tasks-card">
          {shown.rowKey && (
            <li data-occurrence={`working:${shown.rowKey}`} data-group="working">
              <button className="home-task-check" />
              <div className="home-task-content">
                <strong>a</strong>
              </div>
            </li>
          )}
          {!shown.rowKey && (
            <li data-occurrence="today:a:2026-10-31" data-group="today">
              <button className="home-task-check" />
              <div className="home-task-content">
                <strong>a</strong>
              </div>
            </li>
          )}
        </ol>
      </div>
    );
  }

  const page = () => container.querySelector<HTMLElement>('#page')!;
  const draw = (props: Parameters<typeof Probe>[0]) =>
    act(async () => root.render(<Probe {...props} />));
  const namedParts = () =>
    [...container.querySelectorAll<HTMLElement>('*')]
      .filter((element) => element.style.getPropertyValue('view-transition-name') !== '')
      .map((element) => element.style.getPropertyValue('view-transition-name'));

  beforeEach(() => {
    renders = [];
    flippingAt = [];
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(document, 'startViewTransition');
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps the old page, in full, until the browser calls back, and commits exactly once', async () => {
    const { flips, startViewTransition } = stubTransitions();
    await draw({ truth: NORMAL });
    await draw({ truth: { ...WORKING, stamp: 'new' } });

    expect(startViewTransition).toHaveBeenCalledOnce();
    expect(page().dataset.layout).toBe('false');
    expect(page().dataset.stamp).toBe('none');
    expect(flippingAt.at(-1)).toBe(true);
    expect(document.documentElement.getAttribute(WORKING_FLIP_ATTRIBUTE)).toBe('into');
    expect(document.documentElement.hasAttribute(WORKING_FLIP_NEW_ATTRIBUTE)).toBe(false);

    await act(async () => flips[0]!.update());
    expect(page().dataset.layout).toBe('true');
    expect(page().dataset.stamp).toBe('new');
    expect(flippingAt.at(-1)).toBe(false);
    expect(document.documentElement.hasAttribute(WORKING_FLIP_NEW_ATTRIBUTE)).toBe(true);

    const drawn = renders.length;
    await act(async () => flips[0]!.update());
    expect(renders).toHaveLength(drawn);
    expect(startViewTransition).toHaveBeenCalledOnce();

    await act(async () => flips[0]!.finish());
    expect(hasFlipAttributes()).toBe(false);
  });

  it('commits the newest truth when something changes while it waits', async () => {
    const { flips, startViewTransition } = stubTransitions();
    await draw({ truth: WORKING, settled: false });
    await draw({ truth: WORKING });
    await draw({ truth: NORMAL });
    await draw({ truth: { ...NORMAL, stamp: 'later' } });
    expect(page().dataset.layout).toBe('true');
    expect(startViewTransition).toHaveBeenCalledOnce();
    expect(document.documentElement.getAttribute(WORKING_FLIP_ATTRIBUTE)).toBe('back');
    await act(async () => flips[0]!.update());
    expect(page().dataset.stamp).toBe('later');
  });

  it('commits in the same render under reduced motion, without the API, and on a hidden page', async () => {
    await draw({ truth: NORMAL });
    await draw({ truth: WORKING });
    expect(page().dataset.layout).toBe('true');
    expect(flippingAt.every((flipping) => !flipping)).toBe(true);
    await draw({ truth: NORMAL });

    const { startViewTransition } = stubTransitions();
    await draw({ truth: WORKING, reducedMotion: true });
    expect(page().dataset.layout).toBe('true');
    await draw({ truth: NORMAL, reducedMotion: true });

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await draw({ truth: WORKING });
    expect(page().dataset.layout).toBe('true');
    visibility.mockRestore();

    expect(startViewTransition).not.toHaveBeenCalled();
    expect(hasFlipAttributes()).toBe(false);
  });

  it('does not animate the first read, even when it arrives with a card on', async () => {
    const { flips, startViewTransition } = stubTransitions();
    await draw({ truth: NORMAL, settled: false });
    await draw({ truth: WORKING, settled: false });
    expect(page().dataset.layout).toBe('true');
    await draw({ truth: NORMAL, settled: false });
    // The page settles in the same render as the flip: that is still the page opening.
    await draw({ truth: WORKING, settled: true });
    expect(page().dataset.layout).toBe('true');
    expect(startViewTransition).not.toHaveBeenCalled();

    await draw({ truth: NORMAL });
    expect(startViewTransition).toHaveBeenCalledOnce();
    await act(async () => flips[0]!.update());
    expect(page().dataset.layout).toBe('false');
  });

  it('leaves a card swap instant: the layout did not change', async () => {
    const { startViewTransition } = stubTransitions();
    await draw({ truth: WORKING });
    await draw({ truth: { ...WORKING, rowKey: 'b:2026-10-31' } });
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(container.querySelector('[data-occurrence="working:b:2026-10-31"]')).not.toBeNull();
  });

  it('still commits and clears up when the transition is rejected or skipped', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const skipTransition = vi.fn();
    Object.assign(document, {
      startViewTransition: vi.fn((update: () => void) => {
        queueMicrotask(update);
        return {
          ready: Promise.reject(new Error('skipped')),
          updateCallbackDone: Promise.reject(new Error('update failed')),
          finished: Promise.reject(new Error('finished failed')),
          skipTransition,
        };
      }),
    });
    await draw({ truth: NORMAL });
    await draw({ truth: WORKING });
    await act(async () => new Promise((done) => setTimeout(done)));
    expect(page().dataset.layout).toBe('true');
    expect(hasFlipAttributes()).toBe(false);
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
  });

  it('commits at once when the API throws, or hands nothing back', async () => {
    Object.assign(document, {
      startViewTransition: vi.fn(() => {
        throw new Error('not allowed');
      }),
    });
    await draw({ truth: NORMAL });
    await draw({ truth: WORKING });
    expect(page().dataset.layout).toBe('true');
    expect(hasFlipAttributes()).toBe(false);

    Object.assign(document, { startViewTransition: vi.fn() });
    await draw({ truth: NORMAL });
    expect(page().dataset.layout).toBe('false');
    expect(hasFlipAttributes()).toBe(false);
  });

  it('cannot get stuck: a callback that never comes commits on its own, once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { flips } = stubTransitions();
    await draw({ truth: NORMAL });
    await draw({ truth: WORKING });
    await act(async () => vi.advanceTimersByTime(WORKING_FLIP_COMMIT_TIMEOUT_MS - 1));
    expect(page().dataset.layout).toBe('false');
    await act(async () => vi.advanceTimersByTime(1));
    expect(page().dataset.layout).toBe('true');
    expect(flips[0]!.skipTransition).toHaveBeenCalledOnce();
    const drawn = renders.length;
    await act(async () => flips[0]!.update());
    expect(renders).toHaveLength(drawn);
  });

  it('skips and forgets it when the truth turns back before the browser gets to it', async () => {
    const { flips, startViewTransition } = stubTransitions();
    await draw({ truth: NORMAL });
    await draw({ truth: WORKING });
    await draw({ truth: NORMAL });
    expect(page().dataset.layout).toBe('false');
    expect(flips[0]!.skipTransition).toHaveBeenCalledOnce();
    await act(async () => flips[0]!.update());
    await act(async () => flips[0]!.finish());
    expect(page().dataset.layout).toBe('false');
    expect(hasFlipAttributes()).toBe(false);

    await draw({ truth: WORKING });
    expect(startViewTransition).toHaveBeenCalledTimes(2);
    await act(async () => flips[1]!.update());
    expect(page().dataset.layout).toBe('true');
  });

  it('is safe to unmount while waiting, and ends a running flip so a route never animates', async () => {
    const { flips } = stubTransitions();
    await draw({ truth: NORMAL });
    await draw({ truth: WORKING });
    await act(async () => root.unmount());
    expect(flips[0]!.skipTransition).toHaveBeenCalled();
    expect(hasFlipAttributes()).toBe(false);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => flips[0]!.update()).not.toThrow();
    await act(async () => flips[0]!.finish());
    expect(error).not.toHaveBeenCalled();
    expect(hasFlipAttributes()).toBe(false);

    root = createRoot(container);
    await draw({ truth: NORMAL });
    await draw({ truth: WORKING });
    await act(async () => flips[1]!.update());
    expect(document.documentElement.hasAttribute(WORKING_FLIP_ATTRIBUTE)).toBe(true);
    await act(async () => root.unmount());
    expect(flips[1]!.skipTransition).toHaveBeenCalled();
    expect(hasFlipAttributes()).toBe(false);
    root = createRoot(container);
  });

  it('lets a new flip take over a running one, which must not clear it when it ends', async () => {
    const { flips } = stubTransitions();
    await draw({ truth: NORMAL });
    await draw({ truth: WORKING });
    await act(async () => flips[0]!.update());
    await draw({ truth: NORMAL });
    expect(document.documentElement.getAttribute(WORKING_FLIP_ATTRIBUTE)).toBe('back');
    expect(document.documentElement.hasAttribute(WORKING_FLIP_NEW_ATTRIBUTE)).toBe(false);
    await act(async () => flips[0]!.finish());
    expect(document.documentElement.getAttribute(WORKING_FLIP_ATTRIBUTE)).toBe('back');
    await act(async () => flips[1]!.update());
    await act(async () => flips[1]!.finish());
    expect(hasFlipAttributes()).toBe(false);
  });

  it('names one row on each side of the flip, and nothing once it is over', async () => {
    const { flips } = stubTransitions();
    await draw({ truth: NORMAL });
    await draw({ truth: WORKING });
    const listRow = container.querySelector<HTMLElement>('[data-occurrence^="today:"]')!;
    expect(
      listRow.querySelector<HTMLElement>('strong')!.style.getPropertyValue('view-transition-name'),
    ).toBe('working-flip-title');
    expect(
      listRow
        .querySelector<HTMLElement>('.home-task-check')!
        .style.getPropertyValue('view-transition-name'),
    ).toBe('working-flip-check');
    expect(namedParts()).toHaveLength(2);

    await act(async () => flips[0]!.update());
    const cardRow = container.querySelector<HTMLElement>('[data-occurrence^="working:"]')!;
    expect(
      cardRow.querySelector<HTMLElement>('strong')!.style.getPropertyValue('view-transition-name'),
    ).toBe('working-flip-title');
    expect(namedParts()).toHaveLength(2);

    await act(async () => flips[0]!.finish());
    expect(namedParts()).toEqual([]);
  });

  it('never names a row clipped by the list, off the page or finished', async () => {
    const { flips } = stubTransitions();
    await draw({ truth: NORMAL });

    const rect = (top: number, bottom: number) => ({ top, bottom }) as DOMRect;
    const boxes = vi.spyOn(Element.prototype, 'getBoundingClientRect');
    container.querySelector('ol')!.classList.add('home-task-scroll');
    boxes.mockImplementation(function (this: Element) {
      return this.classList.contains('home-task-scroll') ? rect(100, 300) : rect(290, 350);
    });
    await draw({ truth: WORKING });
    expect(namedParts()).toEqual([]);
    await act(async () => flips[0]!.update());
    await act(async () => flips[0]!.finish());
    boxes.mockRestore();

    // Off the bottom of the page, with no scroller around it.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
      rect(window.innerHeight + 10, window.innerHeight + 70),
    );
    await draw({ truth: NORMAL });
    expect(namedParts()).toEqual([]);
    await act(async () => flips[1]!.update());
    await act(async () => flips[1]!.finish());
    vi.restoreAllMocks();

    container.querySelector<HTMLElement>('li')!.dataset.group = 'completed';
    await draw({ truth: WORKING });
    expect(namedParts()).toEqual([]);
  });

  it('never names a row in a hidden list, with nothing else against it', async () => {
    stubTransitions();
    await draw({ truth: NORMAL });
    container.querySelector('ol')!.toggleAttribute('hidden', true);
    await draw({ truth: WORKING });
    expect(namedParts()).toEqual([]);
  });

  it('leaves a row with a wrapped title to the card, since it cannot scale evenly', async () => {
    stubTransitions();
    await draw({ truth: NORMAL });
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([
      {},
      {},
    ] as unknown as DOMRectList);
    await draw({ truth: WORKING });
    expect(namedParts()).toEqual([]);
  });

  it('does not name a row that had nothing to travel from', async () => {
    const { flips } = stubTransitions();
    await draw({ truth: NORMAL });
    const rect = (top: number, bottom: number) => ({ top, bottom }) as DOMRect;
    const boxes = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue(rect(window.innerHeight + 10, window.innerHeight + 70));
    await draw({ truth: WORKING });
    expect(namedParts()).toEqual([]);

    boxes.mockReturnValue(rect(100, 160));
    await act(async () => flips[0]!.update());
    expect(namedParts()).toEqual([]);
  });

  it('holds the contents of a moving box still, unless it leaves its old place', async () => {
    const { flips } = stubTransitions();
    await draw({ truth: NORMAL });
    const { style } = document.documentElement;
    const place = (left: number, top: number, right: number, bottom: number) =>
      ({ left, top, right, bottom }) as DOMRect;
    const measured = [place(100, 10, 500, 400), place(40, 30, 500, 200)];
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      return this.classList.contains('home-tasks-card') ? measured.shift()! : place(0, 0, 0, 0);
    });
    await draw({ truth: WORKING });
    expect(style.getPropertyValue('--working-flip-tasks-x')).toBe('60px');
    expect(style.getPropertyValue('--working-flip-tasks-y')).toBe('-20px');

    await act(async () => flips[0]!.update());
    await act(async () => flips[0]!.finish());
    expect(style.getPropertyValue('--working-flip-tasks-x')).toBe('');

    measured.push(place(100, 10, 500, 400), place(40, 900, 500, 1200));
    await draw({ truth: NORMAL });
    expect(style.getPropertyValue('--working-flip-tasks-x')).toBe('');
  });

  it('keeps focus through a press during a flip, except on a sidebar the browser still hit-tests', async () => {
    const { flips } = stubTransitions();
    await draw({ truth: NORMAL });
    const sidebar = document.createElement('nav');
    sidebar.className = 'dashboard-sidebar';
    container.append(sidebar);
    const press = (target: Element) => {
      const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };

    expect(press(page())).toBe(false);
    await draw({ truth: WORKING });
    expect(press(page())).toBe(true);
    expect(press(sidebar)).toBe(false);
    await act(async () => flips[0]!.update());
    expect(press(page())).toBe(true);
    await act(async () => flips[0]!.finish());
    expect(press(page())).toBe(false);
  });

  describe('a mouse press during a flip', () => {
    const boxes = new Map<Element, DOMRect>();
    const box = (left: number, top: number, right: number, bottom: number) =>
      ({ left, top, right, bottom }) as DOMRect;
    let clicked: string[];
    let clock: number;
    const READY_AT = 1000;

    /** A control of the page, where layout has it. A real named one fails the hit test. */
    function control(label: string, at: DOMRect | null, tag = 'button') {
      const element = document.createElement(tag);
      element.setAttribute('aria-label', label);
      element.addEventListener('click', () => clicked.push(label));
      container.append(element);
      if (at) boxes.set(element, at);
      return element;
    }
    const move = (element: Element, at: DOMRect) => boxes.set(element, at);

    function press(
      x: number,
      y: number,
      { target = page() as Element, detail = 1, button = 0, releaseAt = [x, y] } = {},
    ) {
      const down = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        detail,
        button,
      });
      target.dispatchEvent(down);
      target.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          clientX: releaseAt[0]!,
          clientY: releaseAt[1]!,
          button,
        }),
      );
      return down.defaultPrevented;
    }

    /** Runs the flip up to the new page playing, `elapsed` milliseconds in. */
    async function flipTo(elapsed: number) {
      const { flips } = stubTransitions();
      await draw({ truth: NORMAL });
      return {
        flips,
        async begin() {
          clock = READY_AT;
          await draw({ truth: WORKING });
          await act(async () => flips[0]!.update());
          clock = READY_AT + elapsed;
        },
      };
    }

    beforeEach(() => {
      boxes.clear();
      clicked = [];
      clock = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => clock);
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: Element,
      ) {
        return boxes.get(this) ?? box(0, 0, 0, 0);
      });
    });

    it('clicks what is really there once the new page can be read, and only on release', async () => {
      const flip = await flipTo(WORKING_FLIP_NEW_PAGE_READABLE_MS);
      await flip.begin();
      const putDown = control('先放下 a', box(100, 100, 150, 140));
      expect(press(120, 120)).toBe(true);
      expect(clicked).toEqual(['先放下 a']);
      expect(document.activeElement).toBe(putDown);

      clicked = [];
      expect(press(120, 120, { releaseAt: [200, 300] })).toBe(true);
      expect(clicked).toEqual([]);
    });

    it('moves focus into a field, so typing goes there and not to the button that had it', async () => {
      const flip = await flipTo(WORKING_FLIP_NEW_PAGE_READABLE_MS);
      const check = control('完成 a', box(10, 10, 40, 40));
      await flip.begin();
      const note = control('笔记', box(100, 200, 400, 300), 'textarea');
      check.focus();
      press(200, 250);
      expect(document.activeElement).toBe(note);
    });

    it('does not guess at a new page still too faint to read', async () => {
      const flip = await flipTo(WORKING_FLIP_NEW_PAGE_READABLE_MS - 1);
      await flip.begin();
      control('先放下 a', box(100, 100, 150, 140));
      press(120, 120);
      expect(clicked).toEqual([]);
    });

    it('gives a row that moved its own click, whichever part of the flip it is', async () => {
      const flip = await flipTo(0);
      const start = control('开始 b', box(100, 100, 150, 140));
      await flip.begin();
      move(start, box(800, 400, 850, 440));
      press(120, 120);
      expect(clicked).toEqual(['开始 b']);

      clicked = [];
      clock = READY_AT + 300;
      press(120, 120);
      expect(clicked).toEqual(['开始 b']);
    });

    it('does nothing with two candidates, or with a name two controls share', async () => {
      const flip = await flipTo(300);
      const start = control('开始 b', box(100, 100, 150, 140));
      const same = control('开始 c', box(100, 200, 150, 240));
      control('开始 c', box(300, 200, 350, 240));
      await flip.begin();
      move(start, box(800, 400, 850, 440));
      control('开始 d', box(100, 100, 150, 140));
      press(120, 120);
      expect(clicked).toEqual([]);

      clock = READY_AT;
      move(same, box(100, 300, 150, 340));
      press(120, 220);
      expect(clicked).toEqual([]);
    });

    it('never finishes a task nobody could have aimed at, but keeps one they did', async () => {
      const flip = await flipTo(300);
      const aimed = control('完成 b', box(100, 100, 130, 130));
      aimed.className = 'home-task-check';
      await flip.begin();
      move(aimed, box(800, 400, 830, 430));
      control('完成 c', box(500, 500, 530, 530)).className = 'home-task-check';
      press(510, 510);
      expect(clicked).toEqual([]);
      press(110, 110);
      expect(clicked).toEqual(['完成 b']);
    });

    it('leaves alone the second click of a double-click, other buttons and a live control', async () => {
      const flip = await flipTo(300);
      await flip.begin();
      const live = control('重试', box(100, 100, 150, 140));
      expect(press(120, 120, { detail: 2 })).toBe(true);
      expect(press(120, 120, { button: 2 })).toBe(true);
      expect(clicked).toEqual([]);
      // Hit-tested by the browser: its own click is on the way.
      press(120, 120, { target: live });
      expect(clicked).toEqual([]);
    });

    it('skips what cannot be clicked: disabled, inert, collapsed or clipped by the list', async () => {
      const flip = await flipTo(300);
      const scroller = document.createElement('div');
      scroller.className = 'home-task-scroll';
      container.append(scroller);
      boxes.set(scroller, box(0, 0, 1000, 200));
      await flip.begin();
      (control('关闭', box(100, 100, 150, 140)) as HTMLButtonElement).disabled = true;
      control('撤销', box(200, 100, 250, 140)).setAttribute('inert', '');
      control('收起', null);
      scroller.append(control('开始 z', box(300, 190, 350, 230)));
      press(120, 120);
      press(220, 120);
      press(0, 0);
      press(320, 210);
      expect(clicked).toEqual([]);
      press(320, 195);
      expect(clicked).toEqual(['开始 z']);
    });

    it('does nothing before the new page is in, or after the flip is over', async () => {
      Object.assign(document, {
        startViewTransition: vi.fn((update: () => void) => {
          const finished = new Promise<void>(() => undefined);
          void update;
          return {
            ready: new Promise<void>(() => undefined),
            updateCallbackDone: Promise.resolve(),
            finished,
            skipTransition: vi.fn(),
          };
        }),
      });
      clock = READY_AT + 500;
      await draw({ truth: NORMAL });
      control('添加待办', box(100, 100, 150, 140));
      await draw({ truth: WORKING });
      expect(press(120, 120)).toBe(true);
      expect(clicked).toEqual([]);
      await act(async () => root.unmount());
      root = createRoot(container);
      Reflect.deleteProperty(document, 'startViewTransition');

      const { flips } = stubTransitions();
      await draw({ truth: NORMAL });
      await draw({ truth: WORKING });
      await act(async () => flips[0]!.update());
      await act(async () => flips[0]!.finish());
      expect(press(120, 120)).toBe(false);
      expect(clicked).toEqual([]);
    });

    it('sends a press on a scrolled, named sidebar on to its tab', async () => {
      const flip = await flipTo(0);
      const sidebar = document.createElement('nav');
      sidebar.className = 'dashboard-sidebar';
      container.append(sidebar);
      const tab = control('设置', box(10, 500, 200, 540));
      sidebar.append(tab);
      await flip.begin();
      press(100, 520);
      expect(clicked).toEqual(['设置']);
    });
  });

  it('marks a scrolled page, whose sticky sidebar may shift', async () => {
    stubTransitions();
    await draw({ truth: NORMAL });
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(120);
    await draw({ truth: WORKING });
    expect(document.documentElement.hasAttribute(WORKING_FLIP_SCROLLED_ATTRIBUTE)).toBe(true);
  });
});
