/**
 * Press-and-drag scrolling for the event view's list (`auto-scroll.tsx`), for
 * a touch screen the browser hears as a mouse: an external touch display on a
 * Mac, or a touch frame in mouse emulation. A mouse drag does not scroll a
 * scroll container by itself, so the frame moves its own `scrollTop` with the
 * pointer. Real touch is left to the browser, which pans it natively.
 *
 * Pure and dependency-free so the rules are testable without a DOM.
 */

/** Whether a press starts a drag: the primary button of a mouse or pen, never a finger. */
export function dragsToScroll(pointerType: string, button: number): boolean {
  return pointerType !== "touch" && button === 0;
}

/**
 * The frame's scroll position after the pointer moves from `fromY` to `toY`:
 * the list follows the pointer, so dragging up scrolls further down it. Never
 * above the top; the browser clamps the bottom to what the list can scroll.
 */
export function dragScrollTop(scrollTop: number, fromY: number, toY: number): number {
  return Math.max(0, scrollTop - (toY - fromY));
}
