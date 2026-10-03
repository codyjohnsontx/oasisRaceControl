import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveRaceFeed, liveRaceRow } from "../test/live-race-fixture";
import { RACE_FEED_URL, createRaceFeedPoller } from "./race-feed-poller";

/**
 * The poller is what stands between a 2.5 s timer that never waits and a
 * route that can be slow or hang. Each case here is a way the race screen
 * froze or the server was flooded in the second-opinion review of PR #57.
 */

const TIMEOUT_MS = 4_000;

type Deferred = { resolve(res: Response): void; reject(err: unknown): void; signal: AbortSignal };

/** A fetch whose every call is held until the test settles it. */
function heldFetch() {
  const calls: Deferred[] = [];
  const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal as AbortSignal;
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      calls.push({ resolve, reject, signal });
    });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const ok = (body: unknown) => Response.json(body);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createRaceFeedPoller", () => {
  it("asks the feed and hands a good answer to the screen", async () => {
    const feed = liveRaceFeed([liveRaceRow(1, 1), liveRaceRow(2, 2)]);
    const held = heldFetch();
    const onFeed = vi.fn();
    const onFailure = vi.fn();
    const poller = createRaceFeedPoller({ fetch: held.fetch, timeoutMs: TIMEOUT_MS, onFeed, onFailure });

    const done = poller.poll();
    expect(held.fetch).toHaveBeenCalledWith(RACE_FEED_URL, expect.objectContaining({ cache: "no-store" }));
    held.calls[0].resolve(ok(feed));
    await done;

    expect(onFeed).toHaveBeenCalledWith(feed);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("does not stack requests while one is in flight: a hung request means skipped ticks, not more requests", async () => {
    const held = heldFetch();
    const onFeed = vi.fn();
    const poller = createRaceFeedPoller({ fetch: held.fetch, timeoutMs: TIMEOUT_MS, onFeed, onFailure: vi.fn() });

    const first = poller.poll();
    await poller.poll();
    await poller.poll();
    expect(held.fetch).toHaveBeenCalledTimes(1);

    // Once it answers, the next tick asks again.
    held.calls[0].resolve(ok(liveRaceFeed([liveRaceRow(1, 1), liveRaceRow(2, 2)])));
    await first;
    const second = poller.poll();
    expect(held.fetch).toHaveBeenCalledTimes(2);
    held.calls[1].resolve(ok(liveRaceFeed([liveRaceRow(1, 1), liveRaceRow(2, 2)])));
    await second;
    expect(onFeed).toHaveBeenCalledTimes(2);
  });

  it("aborts a request that outlives the timeout and counts it as a failure", async () => {
    const held = heldFetch();
    const onFeed = vi.fn();
    const onFailure = vi.fn();
    const poller = createRaceFeedPoller({ fetch: held.fetch, timeoutMs: TIMEOUT_MS, onFeed, onFailure });

    const hung = poller.poll();
    vi.advanceTimersByTime(TIMEOUT_MS - 1);
    expect(held.calls[0].signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(held.calls[0].signal.aborted).toBe(true);
    await hung;

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFeed).not.toHaveBeenCalled();

    // The slot is free again: the next tick sends a new request.
    void poller.poll();
    expect(held.fetch).toHaveBeenCalledTimes(2);
  });

  it("reports a failed status and a malformed body as failures", async () => {
    const held = heldFetch();
    const onFailure = vi.fn();
    const poller = createRaceFeedPoller({ fetch: held.fetch, timeoutMs: TIMEOUT_MS, onFeed: vi.fn(), onFailure });

    const bad = poller.poll();
    held.calls[0].resolve(new Response("nope", { status: 503 }));
    await bad;
    const malformed = poller.poll();
    held.calls[1].resolve(ok({ session: null }));
    await malformed;

    expect(onFailure).toHaveBeenCalledTimes(2);
  });

  it("stop() aborts the request in flight and reports nothing, so an unmounted screen has no failure", async () => {
    const held = heldFetch();
    const onFeed = vi.fn();
    const onFailure = vi.fn();
    const poller = createRaceFeedPoller({ fetch: held.fetch, timeoutMs: TIMEOUT_MS, onFeed, onFailure });

    const inFlight = poller.poll();
    poller.stop();
    expect(held.calls[0].signal.aborted).toBe(true);
    await inFlight;
    vi.advanceTimersByTime(TIMEOUT_MS);

    expect(onFailure).not.toHaveBeenCalled();
    expect(onFeed).not.toHaveBeenCalled();
    // Stopping is not final: polling again starts a fresh request.
    void poller.poll();
    expect(held.fetch).toHaveBeenCalledTimes(2);
  });

  it("stop() with nothing in flight is a no-op", () => {
    const held = heldFetch();
    const poller = createRaceFeedPoller({ fetch: held.fetch, timeoutMs: TIMEOUT_MS, onFeed: vi.fn(), onFailure: vi.fn() });
    expect(() => poller.stop()).not.toThrow();
    expect(held.fetch).not.toHaveBeenCalled();
  });
});
