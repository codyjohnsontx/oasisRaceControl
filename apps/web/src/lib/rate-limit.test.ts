import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The venue is one building behind one public address, and on a league night
 * twenty-two customers sign up inside a few minutes. A throttle keyed on that
 * address does not throttle abuse, it throttles the venue - so these tests are
 * written as the room, not as a limiter.
 */

const queryOne = vi.fn();
vi.mock("@/lib/db", () => ({ queryOne: (...args: unknown[]) => queryOne(...args) }));
vi.mock("./db", () => ({ queryOne: (...args: unknown[]) => queryOne(...args) }));

const { allowNewDriver, rateLimit, clientIp, resetRateLimits } = await import("./rate-limit");

/** Every rig code the fleet knows resolves; anything else does not. */
const KNOWN_RIGS = new Map<string, string>(
  Array.from({ length: 22 }, (_, i) => [`qr-rig-${i + 1}`, `rig-uuid-${i + 1}`]),
);

const request = (ip = "203.0.113.7") =>
  new Request("https://oasis.example/api/auth/guest", {
    headers: { "x-forwarded-for": ip },
  });

beforeEach(() => {
  resetRateLimits();
  queryOne.mockReset();
  queryOne.mockImplementation(async (_sql: string, params: unknown[]) => {
    const rigId = KNOWN_RIGS.get(String(params[0]));
    return rigId ? { rig_id: rigId } : null;
  });
});

describe("doors open", () => {
  it("lets a full room of customers sign up from the venue's one address", async () => {
    const venue = request();
    const admitted: number[] = [];
    for (let rig = 1; rig <= 22; rig += 1) {
      if (await allowNewDriver(venue, `qr-rig-${rig}`)) admitted.push(rig);
    }
    expect(admitted).toHaveLength(22);
  });

  it("lets a rig turn over all night without the room running out of allowance", async () => {
    vi.useFakeTimers();
    try {
      const venue = request();
      // Four hours of a busy night: every seat re-sold every twenty minutes.
      for (let round = 0; round < 12; round += 1) {
        for (let rig = 1; rig <= 22; rig += 1) {
          expect(await allowNewDriver(venue, `qr-rig-${rig}`)).toBe(true);
        }
        vi.advanceTimersByTime(20 * 60_000);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives one customer room for the retries a real sign-up takes", async () => {
    const venue = request();
    // Name taken, suggestion, mistyped PIN, a phone that dropped the wifi.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await allowNewDriver(venue, "qr-rig-9")).toBe(true);
    }
  });
});

describe("what the throttle still refuses", () => {
  it("stops one rig's code being used to mint drivers without end", async () => {
    const venue = request();
    const results: boolean[] = [];
    for (let i = 0; i < 40; i += 1) results.push(await allowNewDriver(venue, "qr-rig-3"));
    expect(results.filter(Boolean)).toHaveLength(8);
    expect(results.at(-1)).toBe(false);
  });

  it("does not let a made-up code mint a fresh allowance each time", async () => {
    const venue = request();
    const results: boolean[] = [];
    // A code the fleet does not know is not a seat: these all land in the one
    // address bucket rather than each opening a bucket of their own.
    for (let i = 0; i < 40; i += 1) results.push(await allowNewDriver(venue, `made-up-${i}`));
    expect(results.filter(Boolean)).toHaveLength(10);
  });

  it("keeps the address bucket for somebody who is not at a rig", async () => {
    const phone = request("198.51.100.9");
    const results: boolean[] = [];
    for (let i = 0; i < 40; i += 1) results.push(await allowNewDriver(phone));
    expect(results.filter(Boolean)).toHaveLength(10);
  });

  it("spends one rig's allowance without touching the rig beside it", async () => {
    const venue = request();
    for (let i = 0; i < 12; i += 1) await allowNewDriver(venue, "qr-rig-5");
    expect(await allowNewDriver(venue, "qr-rig-5")).toBe(false);
    expect(await allowNewDriver(venue, "qr-rig-6")).toBe(true);
  });

  it("does not ask the database when no code was supplied", async () => {
    await allowNewDriver(request());
    expect(queryOne).not.toHaveBeenCalled();
  });

  it("only counts a code the fleet still has active", async () => {
    // A re-issued QR still printed on a rig resolves to nothing, so its holder
    // falls back to the address bucket rather than getting a private one.
    queryOne.mockResolvedValue(null);
    const venue = request();
    const results: boolean[] = [];
    for (let i = 0; i < 20; i += 1) results.push(await allowNewDriver(venue, "qr-rig-1"));
    expect(results.filter(Boolean)).toHaveLength(10);
  });
});

describe("the window", () => {
  it("lets a rig sign up again once the minute has passed", async () => {
    vi.useFakeTimers();
    try {
      const venue = request();
      for (let i = 0; i < 8; i += 1) expect(await allowNewDriver(venue, "qr-rig-2")).toBe(true);
      expect(await allowNewDriver(venue, "qr-rig-2")).toBe(false);
      vi.advanceTimersByTime(60_001);
      expect(await allowNewDriver(venue, "qr-rig-2")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("clientIp", () => {
  it("takes the first hop of x-forwarded-for", () => {
    expect(
      clientIp(new Request("https://x/", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } })),
    ).toBe("1.2.3.4");
  });

  it("answers a stable key when there is no header at all", () => {
    // Every request then shares one bucket, which is precisely why the sign-up
    // throttle must not be keyed on this alone.
    expect(clientIp(new Request("https://x/"))).toBe("unknown");
  });
});

describe("rateLimit", () => {
  it("counts per key", () => {
    expect(rateLimit("a", 1, 1_000)).toBe(true);
    expect(rateLimit("a", 1, 1_000)).toBe(false);
    expect(rateLimit("b", 1, 1_000)).toBe(true);
  });
});
