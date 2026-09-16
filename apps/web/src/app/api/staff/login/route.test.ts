import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

/**
 * What the route tells /staff/login apart, and what it deliberately does not.
 *
 * Before this, every refusal here reached the page as one indistinguishable
 * 400/401/500 and the page rendered one message for all of them. The cases
 * below are the four an operator actually hits, and one of them - a wrong
 * email against a wrong password - must stay identical forever.
 */

const queryOne = vi.fn();
const setStaffSession = vi.fn();

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  queryOne: (...args: unknown[]) => queryOne(...args),
  isUniqueViolation: () => false,
}));
vi.mock("@/lib/staff", () => ({
  setStaffSession: (...args: unknown[]) => setStaffSession(...args),
}));

const { POST } = await import("./route");

/** A real hash of "correct-horse", so a wrong password fails a real compare. */
const KNOWN_HASH = bcrypt.hashSync("correct-horse", 6);

/** The rate limiter is module-level and keyed by IP, so every request gets its
 * own address - otherwise the 10-per-minute limit would answer later tests. */
let nextIp = 0;
function post(body: unknown) {
  nextIp += 1;
  return new Request("http://localhost/api/staff/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${nextIp}` },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  queryOne.mockReset();
  setStaffSession.mockReset();
});

describe("POST /api/staff/login", () => {
  it("names a too-short password, and refuses it before any lookup", async () => {
    const response = await POST(post({ email: "shift@oasis.test", password: "oasis12" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "password_too_short" });
    // Before any lookup is what makes it safe to say: the answer cannot depend
    // on whether that address has an account.
    expect(queryOne).not.toHaveBeenCalled();
  });

  it("answers a wrong email exactly as it answers a wrong password", async () => {
    queryOne.mockResolvedValueOnce(null); // no staff row for this address
    const noAccount = await POST(post({ email: "nobody@oasis.test", password: "correct-horse" }));

    queryOne.mockResolvedValueOnce({
      id: "staff-uuid",
      display_name: "Cody",
      password_hash: KNOWN_HASH,
    });
    const wrongPassword = await POST(post({ email: "staff@oasis.test", password: "wrong-horse" }));

    // Identical status AND identical body. Splitting these - even into two
    // codes that happen to render the same today - hands an attacker a list of
    // which addresses are staff accounts.
    const [noAccountBody, wrongPasswordBody] = [await noAccount.json(), await wrongPassword.json()];
    expect(noAccount.status).toBe(wrongPassword.status);
    expect(noAccount.status).toBe(401);
    expect(noAccountBody).toEqual(wrongPasswordBody);
    expect(wrongPasswordBody).toEqual({ error: "invalid_credentials" });
    expect(setStaffSession).not.toHaveBeenCalled();
  });

  it("says a server error is the site's problem, not the operator's typing", async () => {
    queryOne.mockRejectedValueOnce(new Error("connection refused"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(post({ email: "staff@oasis.test", password: "correct-horse" }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "server_error" });
  });

  it("keeps answering rate_limited with 429", async () => {
    const ip = "10.9.9.9";
    const attempt = () =>
      POST(
        new Request("http://localhost/api/staff/login", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": ip },
          body: JSON.stringify({ email: "staff@oasis.test", password: "correct-horse" }),
        }),
      );
    queryOne.mockResolvedValue(null);

    let last = await attempt();
    for (let i = 0; i < 10 && last.status !== 429; i += 1) last = await attempt();

    expect(last.status).toBe(429);
    await expect(last.json()).resolves.toEqual({ error: "rate_limited" });
  });

  it("still signs in a password that is long enough and correct", async () => {
    queryOne.mockResolvedValueOnce({
      id: "staff-uuid",
      display_name: "Cody",
      password_hash: KNOWN_HASH,
    });

    const response = await POST(post({ email: "staff@oasis.test", password: "correct-horse" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ displayName: "Cody" });
    expect(setStaffSession).toHaveBeenCalledWith({ userId: "staff-uuid", displayName: "Cody" });
  });
});
