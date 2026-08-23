import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The guest route is the venue's front door: a walk-in types a name on the rig's
 * check-in page and starts driving. What it must never do is refuse a customer
 * who is standing at a rig, because a customer who cannot check in drives a whole
 * stint whose laps the backend then answers `no_active_assignment` - settled and
 * dropped, with nothing anywhere to recover them from.
 */

const queryOne = vi.fn();
vi.mock("@/lib/db", () => ({
  queryOne: (...args: unknown[]) => queryOne(...args),
  isUniqueViolation: (e: unknown) => (e as { code?: string })?.code === "23505",
}));

const setDriverSession = vi.fn();
vi.mock("@/lib/driver-session", () => ({
  setDriverSession: (...args: unknown[]) => setDriverSession(...args),
}));

const allowNewDriver = vi.fn();
vi.mock("@/lib/rate-limit", () => ({
  allowNewDriver: (...args: unknown[]) => allowNewDriver(...args),
}));

const { POST } = await import("./route");

const post = (body: unknown) =>
  POST(
    new Request("https://oasis.example/api/auth/guest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  queryOne.mockReset().mockResolvedValue({ id: "driver-uuid", display_name: "Ada" });
  setDriverSession.mockReset();
  allowNewDriver.mockReset().mockResolvedValue(true);
});

it("tells the throttle which rig the customer is standing at", async () => {
  await post({ displayName: "Ada", qrToken: "qr-rig-7" });
  expect(allowNewDriver).toHaveBeenCalledWith(expect.any(Request), "qr-rig-7");
});

it("signs the customer in", async () => {
  const res = await post({ displayName: "Ada", qrToken: "qr-rig-7" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ driverId: "driver-uuid", displayName: "Ada" });
  expect(setDriverSession).toHaveBeenCalledWith({
    driverId: "driver-uuid",
    displayName: "Ada",
    isGuest: true,
  });
});

it("still works from a page with no rig code", async () => {
  const res = await post({ displayName: "Ada" });
  expect(res.status).toBe(200);
  expect(allowNewDriver).toHaveBeenCalledWith(expect.any(Request), undefined);
});

it("creates nobody when the throttle refuses, and says why", async () => {
  allowNewDriver.mockResolvedValue(false);
  const res = await post({ displayName: "Ada", qrToken: "qr-rig-7" });
  expect(res.status).toBe(429);
  expect(await res.json()).toEqual({ error: "rate_limited" });
  expect(queryOne).not.toHaveBeenCalled();
  expect(setDriverSession).not.toHaveBeenCalled();
});

it("suggests a free name rather than refusing a taken one", async () => {
  queryOne.mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" }));
  const res = await post({ displayName: "Ada", qrToken: "qr-rig-7" });
  expect(res.status).toBe(409);
  expect((await res.json()).suggestion).toMatch(/^Ada \d\d$/);
});

describe("the rig code itself", () => {
  it("is rejected when it is not a string the fleet could have issued", async () => {
    const res = await post({ displayName: "Ada", qrToken: "x".repeat(200) });
    expect(res.status).toBe(400);
    expect(allowNewDriver).not.toHaveBeenCalled();
  });
});
