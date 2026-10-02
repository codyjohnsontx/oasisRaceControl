import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The name lookup the rig's sign-in window makes before it asks for a PIN:
 * one bit per name, matched the way register and login match, refused before
 * any lookup when the name could never be registered, and throttled per
 * address.
 */

const queryOne = vi.fn();

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  queryOne: (...args: unknown[]) => queryOne(...args),
}));

const { GET } = await import("./route");

/** The rate limiter is module-level and keyed by address, so each test asks
 * from its own, except the one that is about the limit. */
let nextIp = 0;
function get(displayName: string | null, ip?: string) {
  nextIp += 1;
  const url = new URL("http://localhost/api/auth/name");
  if (displayName !== null) url.searchParams.set("displayName", displayName);
  return GET(new Request(url, { headers: { "x-forwarded-for": ip ?? `10.0.1.${nextIp}` } }));
}

beforeEach(() => {
  queryOne.mockReset();
});

describe("GET /api/auth/name", () => {
  it("says a registered name is taken, and nothing else about it", async () => {
    queryOne.mockResolvedValueOnce({ taken: true });

    const response = await get("Mike");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ taken: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(queryOne.mock.calls[0][1]).toEqual(["Mike"]);
  });

  it("says a free name is free", async () => {
    queryOne.mockResolvedValueOnce({ taken: false });

    const response = await get("Alex");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ taken: false });
  });

  it("trims the name the way register will", async () => {
    queryOne.mockResolvedValueOnce({ taken: false });

    await get("  Alex  ");

    expect(queryOne.mock.calls[0][1]).toEqual(["Alex"]);
  });

  it.each([
    ["missing", null],
    ["too short", "A"],
    ["too long", "A".repeat(25)],
    ["characters register refuses", "Mike<script>"],
  ])("refuses a name register could never accept (%s) before any lookup", async (_, name) => {
    const response = await get(name);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_input" });
    expect(queryOne).not.toHaveBeenCalled();
  });

  it("answers a failed query as a server error, not as a free name", async () => {
    queryOne.mockRejectedValueOnce(new Error("connection reset"));

    const response = await get("Mike");

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "server_error" });
  });

  it("throttles one address after sixty lookups in a minute", async () => {
    queryOne.mockResolvedValue({ taken: false });

    for (let i = 0; i < 60; i += 1) {
      expect((await get("Alex", "10.0.9.9")).status).toBe(200);
    }
    const response = await get("Alex", "10.0.9.9");

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: "rate_limited" });
  });
});
