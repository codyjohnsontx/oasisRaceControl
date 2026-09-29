import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Run checks now". What must hold: only staff, from the staff page's own
 * origin, can start an evaluation; it is the ordinary throttled runMonitor,
 * whose answer is passed through; and a failure is a 500, not a pretend run.
 */

const getStaffUser = vi.fn();
const runMonitor = vi.fn();

vi.mock("@/lib/staff", () => ({ getStaffUser: () => getStaffUser() }));
vi.mock("@/lib/monitor/run", () => ({ runMonitor: () => runMonitor() }));

const { POST } = await import("./route");

function post(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/staff/monitor/run", {
    method: "POST",
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json", ...headers },
    body: "{}",
  });
}

const RAN = { evaluated: true, findings: 2, announced: 1, recovered: 0, eventMode: false, routineUpdate: false };

beforeEach(() => {
  getStaffUser.mockReset().mockResolvedValue({ userId: "u1", displayName: "Cody" });
  runMonitor.mockReset().mockResolvedValue(RAN);
});

describe("POST /api/staff/monitor/run", () => {
  it("refuses another origin or anyone not signed in as staff", async () => {
    expect((await POST(post({ origin: "http://evil.test" }))).status).toBe(403);
    getStaffUser.mockResolvedValue(null);
    expect((await POST(post())).status).toBe(403);
    expect(runMonitor).not.toHaveBeenCalled();
  });

  it("runs one evaluation and answers with what it did", async () => {
    await expect((await POST(post())).json()).resolves.toEqual(RAN);
    expect(runMonitor).toHaveBeenCalledTimes(1);
  });

  it("passes on that another evaluation ran moments ago", async () => {
    runMonitor.mockResolvedValue({ evaluated: false });
    await expect((await POST(post())).json()).resolves.toEqual({ evaluated: false });
  });

  it("answers 500 when the evaluation fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    runMonitor.mockRejectedValue(new Error("connect ECONNREFUSED"));
    expect((await POST(post())).status).toBe(500);
  });
});
