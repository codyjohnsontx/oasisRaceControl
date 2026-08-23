import { beforeEach, expect, it, vi } from "vitest";

/** A regular making a profile at the rig is throttled the same way, and for the
 * same reason, as a walk-in taking the guest path beside it. */

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
    new Request("https://oasis.example/api/auth/register", {
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
  const res = await post({ displayName: "Ada", pin: "1234", qrToken: "qr-rig-7" });
  expect(res.status).toBe(200);
  expect(allowNewDriver).toHaveBeenCalledWith(expect.any(Request), "qr-rig-7");
});

it("creates nobody when the throttle refuses", async () => {
  allowNewDriver.mockResolvedValue(false);
  const res = await post({ displayName: "Ada", pin: "1234", qrToken: "qr-rig-7" });
  expect(res.status).toBe(429);
  expect(queryOne).not.toHaveBeenCalled();
  expect(setDriverSession).not.toHaveBeenCalled();
});
