import type { LiveRace } from "@/lib/race-live";

/**
 * One request to the live race feed at a time, each bounded by a timeout.
 *
 * The screens ask for `/api/race/live` every RACE_POLL_MS on a timer that does
 * not wait for the last answer (`useVisiblePoll`). Without this, a route that
 * takes longer than the cadence has every wall and every open phone adding a
 * concurrent request each tick for as long as the slowness lasts, and a request
 * that hangs rather than failing never reaches the failure reducer, so the
 * last race stays on the wall as if it were live. So:
 *
 *   - `poll()` while a request is in flight does nothing; the tick is simply
 *     skipped and the next one asks again.
 *   - Every request carries an abort signal that fires after `timeoutMs`, and
 *     a timed-out request counts as a failed one, so the screen marks itself
 *     stale and the race ages off through the same path as a feed that errors.
 *   - `stop()` aborts the request in flight without reporting it: it is what
 *     polling stops with - the round closed, the tab is hidden, the component
 *     unmounted - and an abandoned screen has no failure to show.
 *
 * Plain TypeScript with the fetch injected, so the whole contract is tested
 * without React or a DOM (`race-feed-poller.test.ts`). The response-order
 * guard stays as defence in depth: single flight already makes a late answer
 * impossible, but a guard that is wrong costs nothing and one that is missing
 * is how a stale order got drawn once.
 */
export type RaceFeedPoller = {
  /** Ask the feed once, unless a request is already in flight. */
  poll(): Promise<void>;
  /** Abort the request in flight, if any, reporting nothing. */
  stop(): void;
};

export type RaceFeedPollerOptions = {
  fetch: typeof globalThis.fetch;
  /** How long one request may take before it counts as a failure. */
  timeoutMs: number;
  onFeed(feed: LiveRace): void;
  onFailure(): void;
};

export const RACE_FEED_URL = "/api/race/live";

export function createRaceFeedPoller(options: RaceFeedPollerOptions): RaceFeedPoller {
  let inFlight: { controller: AbortController; stopped: boolean } | null = null;
  let sent = 0;
  let applied = 0;

  const poll = async (): Promise<void> => {
    if (inFlight) return;
    const controller = new AbortController();
    const request = { controller, stopped: false };
    inFlight = request;
    const seq = ++sent;
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);

    // A request that is not the newest answered has nothing to say. With one
    // request at a time this is always true; it is kept as defence in depth.
    const current = () => {
      if (seq < applied) return false;
      applied = seq;
      return true;
    };

    let feed: LiveRace;
    try {
      const res = await options.fetch(RACE_FEED_URL, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      feed = (await res.json()) as LiveRace;
      if (!Array.isArray(feed.rows)) throw new Error("malformed race response");
    } catch {
      clearTimeout(timer);
      if (inFlight === request) inFlight = null;
      if (request.stopped || !current()) return;
      options.onFailure();
      return;
    }
    clearTimeout(timer);
    if (inFlight === request) inFlight = null;
    if (request.stopped || !current()) return;
    options.onFeed(feed);
  };

  const stop = () => {
    if (!inFlight) return;
    inFlight.stopped = true;
    inFlight.controller.abort();
    inFlight = null;
  };

  return { poll, stop };
}
