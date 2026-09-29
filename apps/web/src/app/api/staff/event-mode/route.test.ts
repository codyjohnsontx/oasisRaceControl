import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Staff's event-mode override. What must hold: only staff, from the staff
 * page's own origin, can set it; `on` and `off` record who set it and lapse
 * at venue midnight; `auto` clears all three; every change writes an audit
 * row in the same transaction; and the change is evaluated at once. The
 * midnight expression itself is pinned against Postgres in
 * src/lib/monitor/monitor.integration.test.ts.
 */

const query = vi.fn();
const withTransaction = vi.fn();
const getStaffUser = vi.fn();
const scheduleMonitor = vi.fn();

vi.mock("@/lib/db", () => ({ withTransaction: (fn: unknown) => withTransaction(fn) }));
vi.mock("@/lib/staff", () => ({ getStaffUser: () => getStaffUser() }));
vi.mock("@/lib/monitor/run", () => ({ scheduleMonitor: () => scheduleMonitor() }));

const { POST } = await import("./route");

const STAFF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MIDNIGHT = new Date("2026-10-05T05:00:00Z");

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/staff/event-mode", {
    method: "POST",
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function statement(fragment: string): [string, unknown[]] {
  const call = query.mock.calls.find(([sql]) => String(sql).includes(fragment));
  return [String(call![0]), call![1] as unknown[]];
}

beforeEach(() => {
  query.mockReset().mockImplementation(async (sql: string, params: unknown[]) =>
    sql.includes("insert into monitor_state")
      ? { rows: [{ expires_at: params[0] === null ? null : MIDNIGHT }] }
      : { rows: [] },
  );
  withTransaction.mockReset().mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn({ query }));
  getStaffUser.mockReset().mockResolvedValue({ userId: STAFF, displayName: "Cody" });
  scheduleMonitor.mockReset();
});

describe("POST /api/staff/event-mode", () => {
  it("refuses another origin or a non-JSON body before looking at the session", async () => {
    expect((await POST(post({ mode: "on" }, { origin: "http://evil.test" }))).status).toBe(403);
    expect((await POST(post({ mode: "on" }, { "content-type": "text/plain" }))).status).toBe(415);
    expect(getStaffUser).not.toHaveBeenCalled();
  });

  it("refuses anyone who is not signed in as staff", async () => {
    getStaffUser.mockResolvedValue(null);
    expect((await POST(post({ mode: "on" }))).status).toBe(403);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("refuses a mode it does not know", async () => {
    expect((await POST(post({ mode: "forever" }))).status).toBe(400);
  });

  it("sets on until venue midnight, as this staff member, with an audit row, and evaluates", async () => {
    const response = await POST(post({ mode: "on", reason: "league night" }));
    await expect(response.json()).resolves.toEqual({ mode: "on", expiresAt: MIDNIGHT.toISOString() });

    const [sql, params] = statement("insert into monitor_state");
    expect(params).toEqual(["on", STAFF]);
    expect(sql).toContain("at time zone 'America/Chicago')::date + 1)::timestamp at time zone 'America/Chicago'");
    const [, audit] = statement("insert into audit_log");
    expect(audit).toEqual([STAFF, "league night", { mode: "on", expiresAt: MIDNIGHT.toISOString() }]);
    expect(scheduleMonitor).toHaveBeenCalledTimes(1);
  });

  it("hands the decision back to the boards on auto", async () => {
    const response = await POST(post({ mode: "auto" }));
    await expect(response.json()).resolves.toEqual({ mode: "auto", expiresAt: null });
    expect(statement("insert into monitor_state")[1]).toEqual([null, STAFF]);
    expect(statement("insert into audit_log")[1]).toEqual([STAFF, null, { mode: "auto", expiresAt: null }]);
  });

  it("answers 500 without evaluating when the write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    withTransaction.mockRejectedValue(new Error("connect ECONNREFUSED"));
    expect((await POST(post({ mode: "off" }))).status).toBe(500);
    expect(scheduleMonitor).not.toHaveBeenCalled();
  });
});
