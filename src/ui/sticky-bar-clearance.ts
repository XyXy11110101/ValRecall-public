/** Room left between the line being typed in and the top of the bar. */
const GAP_PX = 16;
const barsOn = new WeakMap<HTMLElement, Set<HTMLElement>>();

/**
 * Tells the browser how much of the window a sticky save bar covers. When focus or typing moves the
 * caret, the browser only scrolls enough to show it inside the page's scroll padding: a scroll margin
 * on the field has no effect there, so without this a field can sit under the bar while being typed in.
 *
 * It is the bar's real height, so larger text or a notice in the bar counts, and a field that is
 * already clear does not move.
 */
export function clearFocusOfStickyBar(
  bar: HTMLElement,
  root: HTMLElement = document.documentElement,
): () => void {
  // Add and Library stay mounted while hidden, so a page can hold several bars, each 0 tall but one.
  const bars = barsOn.get(root) ?? new Set<HTMLElement>();
  barsOn.set(root, bars);
  bars.add(bar);
  const write = () => {
    const heights = [...bars].map((each) => each.getBoundingClientRect().height);
    const height = Math.ceil(Math.max(...heights, 0));
    if (height > 0) root.style.setProperty('scroll-padding-block-end', `${height + GAP_PX}px`);
    else root.style.removeProperty('scroll-padding-block-end');
  };
  write();
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(write) : null;
  observer?.observe(bar);
  return () => {
    observer?.disconnect();
    bars.delete(bar);
    write();
  };
}

/** For `ref={stickyBarClearance}` on the bar itself. */
export function stickyBarClearance(bar: HTMLElement | null): (() => void) | undefined {
  return bar ? clearFocusOfStickyBar(bar) : undefined;
}
