import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { mintBoardTicket, verifyBoardTicket } from "@/lib/board-ticket";

/**
 * The TV board's heartbeat route is public, so what must hold: a heartbeat is
 * believed only as far as its ticket - board, mode and host come from the
 * ticket, never the body, and a forged or foreign ticket stores nothing and
 * runs no evaluation; an accepted heartbeat renews the ticket and runs one; a
 * goodbye closes the board and runs none. The same route against Postgres is
 * in route.integration.test.ts.
 */

const query = vi.fn();
const scheduleMonitor = vi.fn();

vi.mock("@/lib/db", () => ({ query: (...args: unknown[]) => query(...args) }));
vi.mock("@/lib/monitor/run", () => ({ scheduleMonitor: () => scheduleMonitor() }));

const { POST } = await import("./route");

const BOARD = "0b9c5b1e-6a3f-4a55-9a52-3f1c2d7e8a10";

function post(body: unknown, contentType = "application/json") {
  return new Request("http://localhost/api/tv/heartbeat", {
    method: "POST",
    headers: { "content-type": contentType, "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify(body),
  });
}

/** The upsert's parameters: board id, mode, host, visible, feed ok, failures, closing, reopened. */
function stored(): unknown[] {
  const call = query.mock.calls.find(([sql]) => String(sql).includes("insert into board_heartbeats"));
  return call![1] as unknown[];
}

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "tv-heartbeat-route-test-secret");
  query.mockReset().mockResolvedValue([]);
  scheduleMonitor.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/tv/heartbeat", () => {
  it("stores the ticket's board, renews the ticket and runs an evaluation", async () => {
    const ticket = await mintBoardTicket({ boardId: BOARD, mode: "event", host: "cadillac" });
    const response = await POST(post({ ticket, visible: true, feedOk: false, feedFailures: 3 }));

    expect(response.status).toBe(200);
    expect(stored()).toEqual([BOARD, "event", "cadillac", true, false, 3, false, false]);
    const { ticket: renewed } = (await response.json()) as { ticket: string };
    await expect(verifyBoardTicket(renewed)).resolves.toEqual({ boardId: BOARD, mode: "event", host: "cadillac" });
    expect(scheduleMonitor).toHaveBeenCalledTimes(1);
  });

  it("takes the mode from the ticket, never from the body", async () => {
    const ticket = await mintBoardTicket({ boardId: BOARD, mode: "rotation", host: null });
    await POST(post({ ticket, mode: "event", host: "cadillac", boardId: "someone-else" }));
    expect(stored().slice(0, 3)).toEqual([BOARD, "rotation", null]);
  });

  it("refuses a forged ticket, storing nothing and evaluating nothing", async () => {
    const forged = await new SignJWT({ mode: "event", host: null })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(BOARD)
      .setAudience("tv-board")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("not-the-venue-secret"));
    for (const ticket of [forged, "garbage"]) {
      const response = await POST(post({ ticket }));
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "invalid_ticket" });
    }
    expect(query).not.toHaveBeenCalled();
    expect(scheduleMonitor).not.toHaveBeenCalled();
  });

  it("closes the board on a goodbye sent as text/plain by sendBeacon, and evaluates nothing", async () => {
    const ticket = await mintBoardTicket({ boardId: BOARD, mode: "event", host: null });
    const response = await POST(post({ ticket, visible: false, feedOk: true, feedFailures: 0, closing: true }, "text/plain;charset=UTF-8"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(stored()).toEqual([BOARD, "event", null, false, true, 0, true, false]);
    expect(scheduleMonitor).not.toHaveBeenCalled();
  });

  it("refuses a malformed body", async () => {
    expect((await POST(post({ visible: true }))).status).toBe(400);
    expect((await POST(post({ ticket: "x", feedFailures: -1 }))).status).toBe(400);
  });

  it("answers 503, not 401, when it cannot check tickets at all", async () => {
    const ticket = await mintBoardTicket({ boardId: BOARD, mode: "event", host: null });
    vi.stubEnv("SESSION_SECRET", "");
    expect((await POST(post({ ticket }))).status).toBe(503);
  });

  it("answers 500 when the database is down, after checking the ticket", async () => {
    const ticket = await mintBoardTicket({ boardId: BOARD, mode: "event", host: null });
    query.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const response = await POST(post({ ticket }));
    expect(response.status).toBe(500);
    expect(scheduleMonitor).not.toHaveBeenCalled();
  });
});
