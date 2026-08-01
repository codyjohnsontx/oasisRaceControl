"use client";

import { useEffect, useRef } from "react";

/**
 * Poll on an interval, but only while there is something to poll for and the
 * tab is actually being looked at.
 *
 * Both league surfaces live on customers' phones in the paddock, where a
 * backgrounded tab polling every few seconds costs their battery and the
 * venue's database for a screen nobody can see. Coming back to the tab
 * refreshes immediately rather than waiting out the interval, so a phone
 * unlocked mid-round shows current times straight away.
 *
 * The cadence is deliberately independent of `refresh`'s identity: callers
 * whose callback closes over interaction state (which rows are expanded) would
 * otherwise clear and restart the interval on every tap, so a driver browsing
 * the field could hold the board still indefinitely.
 */
export function useVisiblePoll(
  refresh: () => void,
  intervalMs: number,
  active: boolean,
): void {
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!active) return;

    const tick = () => latest.current();
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      timer ??= setInterval(tick, intervalMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        stop();
      } else {
        tick();
        start();
      }
    };

    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs, active]);
}
