"use client";

import {
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  type TouchEvent,
  type WheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { dragScrollTop, dragsToScroll } from "./drag-scroll";

/**
 * Scrolls its content on its own when there is more of it than fits, for a
 * board nobody is standing next to: the event view of `/tv` puts every driver
 * with a lap today on a laptop screen, and the ones below the fold have to come
 * up by themselves.
 *
 * How it moves: the content is drawn twice, one copy under the other with a
 * rule between them, and the pair slides up by exactly one copy before the
 * animation repeats - so the moment the first copy has gone the second is in
 * its place and the loop is seamless. Each pass starts with a short hold at
 * the top (`tv-auto-scroll` in `globals.css`), so the leader is on screen and
 * still for a few seconds every loop rather than only ever seen moving.
 *
 * The pace is per row, not per loop, so a long list is not rushed to fit a
 * fixed period: every row crosses the screen at the same speed however many
 * there are. The duration is set from the row count alone, which is what
 * keeps a live refresh from disturbing the scroll - a new lap time changes the
 * text, not the animation. A new driver changes the loop's length, and that
 * restarts the scroll from the leader's hold: a running animation handed a new
 * duration keeps its elapsed time, so after the page has been up a while it
 * would otherwise land the list at an arbitrary point.
 *
 * Somebody can also take the list in hand. The event's board may be projected
 * on a touch screen, so the first touch, press or wheel on the frame stops the
 * animation and hands the list over: the frame is a real scroll container the
 * whole time (`overflow-y: auto`, scrollbar hidden), so the browser pans it
 * natively from the first swipe, and the takeover converts where the animation
 * had got to into the frame's own scroll position - the rows do not jump,
 * except across the seam, where the list is taken up at whichever copy fills
 * more of the frame - and drops the second copy, so what is left is the one
 * list, top to bottom. A touch screen the browser hears as a mouse (an external
 * display on a Mac) pans nothing natively, so a mouse or pen press-and-drag
 * moves the frame's scroll position with the pointer (`drag-scroll.ts`).
 * `IDLE_RESUME_MS` after the last touch, drag, wheel or scroll (a finger still
 * on the glass, or a button still held on the list, counts as touching), it
 * goes back to the top and the animation starts
 * again from the leader's hold. A live refresh during the hand-over changes the
 * rows in place and leaves the scroll position and the idle clock alone; a new
 * driver does not restart anything until the board is back on its own.
 *
 * Content that fits is drawn once and left alone: the rows are measured
 * against the box, and a fresh `ResizeObserver` reading on either flips the
 * scroll on or off. Deliberately not disabled under `prefers-reduced-motion`:
 * for this board the motion is how the rest of the list is seen at all, and
 * a kiosk has no one to turn the preference on.
 */

/** Time for one row to travel its own height - the reading pace. */
const MS_PER_ROW = 1_600;
/**
 * Share of every loop spent holding at the top. It is the `8%` keyframe stop
 * of `tv-auto-scroll` in `globals.css` - a keyframe selector cannot read a
 * custom property, so the number is repeated here and the two must agree. The
 * duration below is stretched by it so the moving part still runs at
 * `MS_PER_ROW`.
 */
const TOP_HOLD_FRACTION = 0.08;
/**
 * How long the list stays in someone's hands after they last touched, wheeled
 * or scrolled it before the automatic scroll resumes from the top. The owner
 * was told twenty seconds.
 */
export const IDLE_RESUME_MS = 20_000;
/**
 * How long a finger or drag the frame believes is still down defers the
 * resume, with no event from it at all, before that belief is treated as a
 * lift it never saw.
 * A finger resting on the glass sends nothing, so it cannot be told from a
 * `touchend` that went to a row the list had just replaced - and the second
 * must not park the board on one screen for the rest of the night.
 */
const STALE_TOUCH_MS = 60_000;

type Props = {
  /** Rows in `children`, which set the loop's duration. */
  rowCount: number;
  children: ReactNode;
};

export function AutoScroll({ rowCount, children }: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const mover = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  /** True while someone has the list: no animation, one copy, native scroll. */
  const [held, setHeld] = useState(false);
  /** `held` as the handlers read it, so a burst of events takes over once. */
  const heldRef = useRef(false);
  /**
   * Where the rows were on screen at the moment of the takeover, as the scroll
   * position that shows the same rows once the animation is gone. Read in the
   * event handler, while the transform is still there to be measured, and
   * applied after the re-render has removed it.
   */
  const handover = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touches = useRef(0);
  /** When the frame last heard from a touch or drag, to age them (see `STALE_TOUCH_MS`). */
  const lastTouchAt = useRef(0);
  /** The mouse or pen dragging the list, and where it last was. */
  const drag = useRef<{ pointerId: number; y: number } | null>(null);
  /**
   * The row count the loop was keyed on when the list was taken over. Held
   * under the same key, so the takeover re-renders the rows rather than
   * remounting them: the press that takes over lands on a row before its
   * `touchstart` is dispatched, and a row detached in between takes that touch
   * and its lift out of the frame, so a finger resting there would go uncounted.
   */
  const [heldKey, setHeldKey] = useState(rowCount);
  /**
   * The list's height as the scroll handler last saw it. A new driver above
   * the rows on screen grows the list, and the browser's scroll anchoring moves
   * the frame to keep the same rows in view - a scroll nobody made, which must
   * not push the idle clock.
   */
  const listHeight = useRef(0);

  useEffect(() => {
    const frameEl = frame.current;
    const contentEl = content.current;
    if (!frameEl || !contentEl) return;
    // Delivers an initial reading on observe, so there is no first measurement
    // to take here by hand.
    const observer = new ResizeObserver(() => {
      setOverflows(contentEl.offsetHeight > frameEl.clientHeight + 1);
    });
    observer.observe(frameEl);
    observer.observe(contentEl);
    return () => observer.disconnect();
  }, [rowCount, held]);

  // The scroll position is the frame's, which outlives the re-render that swaps
  // the animated pair for the single list, so it is set here, once the swap is
  // in the DOM and before it is painted. Going back the other way starts the
  // animation from the top, so the frame goes to the top with it.
  useLayoutEffect(() => {
    const frameEl = frame.current;
    if (!frameEl) return;
    frameEl.scrollTop = held ? handover.current : 0;
  }, [held]);

  useEffect(() => {
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, []);

  const armIdle = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    const resumeIfIdle = () => {
      idleTimer.current = null;
      // A finger still resting on the list is not idle, whatever the clock
      // says, so the timer defers itself while a touch or drag is down. But
      // one the frame has heard nothing from for `STALE_TOUCH_MS` is one whose
      // lift it missed, and the list is given back.
      const down = touches.current !== 0 || drag.current !== null;
      if (down && Date.now() - lastTouchAt.current < STALE_TOUCH_MS) {
        idleTimer.current = setTimeout(resumeIfIdle, IDLE_RESUME_MS);
        return;
      }
      touches.current = 0;
      drag.current = null;
      heldRef.current = false;
      setHeld(false);
    };
    idleTimer.current = setTimeout(resumeIfIdle, IDLE_RESUME_MS);
  }, []);

  const takeOver = useCallback(() => {
    const frameEl = frame.current;
    const moverEl = mover.current;
    if (!frameEl || !moverEl || heldRef.current || !overflows) return;
    heldRef.current = true;
    // The rows' visual offset is whatever the animation has translated plus
    // whatever the browser has already scrolled natively - both are in the
    // rectangles, neither has to be parsed out of a transform matrix.
    const offset = frameEl.getBoundingClientRect().top - moverEl.getBoundingClientRect().top;
    const passHeight = (moverEl.firstElementChild as HTMLElement).offsetHeight;
    handover.current =
      offset > passHeight - frameEl.clientHeight / 2 ? Math.max(0, offset - passHeight) : offset;
    listHeight.current = (content.current as HTMLElement).offsetHeight;
    setHeldKey(rowCount);
    setHeld(true);
  }, [overflows, rowCount]);

  const onPointerDown = (event: PointerEvent) => {
    takeOver();
    if (dragsToScroll(event.pointerType, event.button)) {
      drag.current = { pointerId: event.pointerId, y: event.clientY };
      lastTouchAt.current = Date.now();
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    armIdle();
  };
  const onPointerMove = (event: PointerEvent) => {
    const frameEl = frame.current;
    const current = drag.current;
    if (!frameEl || current?.pointerId !== event.pointerId) return;
    frameEl.scrollTop = dragScrollTop(frameEl.scrollTop, current.y, event.clientY);
    current.y = event.clientY;
    lastTouchAt.current = Date.now();
  };
  // Fires on release and on cancel alike, once the capture taken on the press goes.
  const onLostPointerCapture = (event: PointerEvent) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    armIdle();
  };
  const onTouchStart = (event: TouchEvent) => {
    touches.current = event.touches.length;
    lastTouchAt.current = Date.now();
    takeOver();
    // Armed, not cleared: the timer defers itself while the finger is fresh
    // (`armIdle`), and a lift the frame never hears about then still ends in
    // a resume rather than in no timer at all.
    armIdle();
  };
  const onTouchMove = () => {
    lastTouchAt.current = Date.now();
  };
  const onTouchEnd = (event: TouchEvent) => {
    touches.current = event.touches.length;
    lastTouchAt.current = Date.now();
    if (touches.current === 0) armIdle();
  };
  const onWheel = (event: WheelEvent) => {
    if (event.deltaY === 0) return;
    takeOver();
    armIdle();
  };
  const onScroll = () => {
    const frameEl = frame.current;
    const contentEl = content.current;
    if (!frameEl || !contentEl) return;
    const height = contentEl.offsetHeight;
    const resized = height !== listHeight.current;
    listHeight.current = height;
    // With no finger down, a scroll that comes with the list changing height is
    // the browser keeping the rows in place across a refresh (see `listHeight`).
    if (heldRef.current && resized && touches.current === 0) return;
    // Going back to the top on resume also scrolls, at 0, and must not count
    // as somebody taking the list back; any other scroll the handlers above
    // did not see (a keyboard, an assistive device) does.
    if (!heldRef.current && frameEl.scrollTop === 0) return;
    takeOver();
    // Momentum after a flick keeps scrolling with no finger down: each step
    // pushes the idle clock, so the resume counts from where the list came to
    // rest.
    armIdle();
  };

  const durationMs = Math.round((rowCount * MS_PER_ROW) / (1 - TOP_HOLD_FRACTION));
  const animating = overflows && !held;
  const pass = overflows ? (held ? `${PASS_CLASS} ${HELD_PASS_CLASS}` : PASS_CLASS) : undefined;

  return (
    <div
      ref={frame}
      data-tv-auto-scroll
      data-tv-auto-scroll-held={held ? "" : undefined}
      className={`relative min-h-0 flex-1 touch-pan-y overflow-x-hidden overflow-y-auto overscroll-contain ${overflows ? "tv-auto-scroll-frame" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onLostPointerCapture={onLostPointerCapture}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
      onWheel={onWheel}
      onScroll={onScroll}
    >
      <div
        ref={mover}
        // Keyed on the row count while animating, so a new driver restarts the
        // loop (see above); on the count it had at the takeover while held, so
        // taking over keeps the touched rows in the document (see `heldKey`) and
        // a new driver then changes the rows in place and the frame's scroll
        // position stands.
        key={held ? heldKey : rowCount}
        className={animating ? "tv-auto-scroll" : undefined}
        style={{ "--tv-scroll-duration": `${durationMs}ms` } as CSSProperties}
      >
        <div className={pass}>
          <div ref={content} className="flow-root">
            {children}
          </div>
          {overflows && <LoopRule hidden={held} />}
        </div>
        {/* Hidden rather than removed while held, for the same reason as `heldKey`: the press may land on this copy. */}
        {overflows && (
          <div aria-hidden="true" hidden={held} className={pass}>
            <div className="flow-root">{children}</div>
            <LoopRule />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One pass of the loop: the list and the rule after it, as a single block. It
 * is `flow-root` so no margin inside it collapses across its edges - the two
 * passes must be boxes of the same height for `-50%` to land exactly on the
 * second - and it starts below the frame's top fade, so the leader is fully
 * lit through the hold.
 */
const PASS_CLASS = "flow-root pt-[var(--tv-scroll-fade)]";
/** The one list in someone's hands ends below the bottom fade, so its last row is fully lit too. */
const HELD_PASS_CLASS = "pb-[var(--tv-scroll-fade)]";

/** Marks where one pass of the list ends and the next begins. */
function LoopRule({ hidden }: { hidden?: boolean }) {
  return <div hidden={hidden} className="gradient-rule my-[1.25em] h-[0.25em] rounded-full opacity-60" />;
}
