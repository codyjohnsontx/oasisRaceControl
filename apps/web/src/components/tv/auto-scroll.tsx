"use client";

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";

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
 * text, not the animation, and a new driver only lengthens the loop, which the
 * browser re-times in place rather than restarting (proven on the laptop size
 * with laps landing mid-scroll when this shipped).
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

type Props = {
  /** Rows in `children`, which set the loop's duration. */
  rowCount: number;
  children: ReactNode;
};

export function AutoScroll({ rowCount, children }: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);

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
  }, []);

  const durationMs = Math.round((rowCount * MS_PER_ROW) / (1 - TOP_HOLD_FRACTION));
  const pass = overflows ? PASS_CLASS : undefined;

  return (
    <div
      ref={frame}
      data-tv-auto-scroll
      className={`relative min-h-0 flex-1 overflow-hidden ${overflows ? "tv-auto-scroll-frame" : ""}`}
    >
      <div
        className={overflows ? "tv-auto-scroll" : undefined}
        style={{ "--tv-scroll-duration": `${durationMs}ms` } as CSSProperties}
      >
        <div className={pass}>
          <div ref={content} className="flow-root">
            {children}
          </div>
          {overflows && <LoopRule />}
        </div>
        {overflows && (
          <div aria-hidden="true" className={pass}>
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

/** Marks where one pass of the list ends and the next begins. */
function LoopRule() {
  return <div className="gradient-rule my-[1.25em] h-[0.25em] rounded-full opacity-60" />;
}
