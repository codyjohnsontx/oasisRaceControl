import { beforeEach, describe, expect, it } from "vitest";
import { feedHealth, reportingFeedHealth, resetFeedHealth } from "./tv-feed-health";
import type { AnyTvBoardDefinition } from "./tv-rotation";

/**
 * What the /tv heartbeat reports as the board's feed: failed loads in a row,
 * reset by any load that succeeds. A load that timed out failed; a load the
 * page cancelled as it was torn down did not.
 */

function definition(load: AnyTvBoardDefinition["load"]): AnyTvBoardDefinition {
  return reportingFeedHealth({ kind: "test", load, hasContent: () => true, Board: () => null });
}

const ok = definition(async () => ["row"]);
const failing = definition(async () => {
  throw new Error("status 500");
});

beforeEach(() => resetFeedHealth());

describe("feed health", () => {
  it("is unknown before the first load finishes", () => {
    expect(feedHealth()).toEqual({ ok: null, failures: 0 });
  });

  it("counts failed loads in a row and resets on a success, passing data and errors through", async () => {
    await expect(failing.load(null, new AbortController().signal)).rejects.toThrow("status 500");
    await expect(failing.load(null, new AbortController().signal)).rejects.toThrow();
    expect(feedHealth()).toEqual({ ok: false, failures: 2 });
    await expect(ok.load(null, new AbortController().signal)).resolves.toEqual(["row"]);
    expect(feedHealth()).toEqual({ ok: true, failures: 0 });
  });

  it("counts a timeout as a failure, and a teardown's abort as nothing", async () => {
    const hangs = definition(
      (_spec, signal) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    );
    const timeout = AbortSignal.timeout(1);
    await expect(hangs.load(null, timeout)).rejects.toThrow();
    expect(feedHealth()).toEqual({ ok: false, failures: 1 });

    const teardown = new AbortController();
    const pending = hangs.load(null, teardown.signal);
    teardown.abort();
    await expect(pending).rejects.toThrow();
    expect(feedHealth()).toEqual({ ok: false, failures: 1 });
  });
});
