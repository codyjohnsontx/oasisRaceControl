import type { AnyTvBoardDefinition } from "@/lib/tv-rotation";

/**
 * Whether the /tv page's boards are loading their numbers, for the page's
 * heartbeat to report (components/tv/board-heartbeat.tsx, rule 8b of the rig
 * monitor). It is the same fact the footer's wordmark shows as "Reconnecting":
 * the engine marks the board stale exactly when a load fails. The rotation
 * engine (tv-screen.tsx) is not changed to expose it; instead every
 * registered board type's `load` is wrapped here, and the heartbeat reads the
 * result. Module state, because the engine and the heartbeat are separate
 * components on one page.
 */

let consecutiveFailures = 0;
let lastOk: boolean | null = null;

export type FeedHealth = {
  /** Whether the latest load succeeded; null before any load finished. */
  ok: boolean | null;
  /** Loads that failed in a row, up to now. */
  failures: number;
};

export function feedHealth(): FeedHealth {
  return { ok: lastOk, failures: consecutiveFailures };
}

export function recordFeedLoad(ok: boolean): void {
  lastOk = ok;
  consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
}

/**
 * The definition with its `load` reporting each outcome. A load the engine
 * cancelled itself - the page being torn down, which aborts with an
 * AbortError - is neither: nothing failed. A load that timed out did fail.
 */
export function reportingFeedHealth(definition: AnyTvBoardDefinition): AnyTvBoardDefinition {
  return {
    ...definition,
    async load(spec, signal) {
      try {
        const data = await definition.load(spec, signal);
        recordFeedLoad(true);
        return data;
      } catch (error) {
        const cancelled =
          signal.aborted && signal.reason instanceof DOMException && signal.reason.name === "AbortError";
        if (!cancelled) recordFeedLoad(false);
        throw error;
      }
    },
  };
}

/** Tests only: a fresh page. */
export function resetFeedHealth(): void {
  consecutiveFailures = 0;
  lastOk = null;
}
