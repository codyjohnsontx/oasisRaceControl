import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The tick's contract without a database: who may call it, and what it
 * answers when the database or the evaluation fails. The evaluation itself is
 * covered in src/lib/monitor; the 503 against a real stopped database was
 * proven end to end against `next start` when the route landed.
 */

const probeDatabase = vi.fn();
const runMonitor = vi.fn();
const monitorStatus = vi.fn();

vi.mock("@/lib/readiness", () => ({ probeDatabase: (tag: string) => probeDatabase(tag) }));
vi.mock("@/lib/monitor/run", () => ({ runMonitor: () => runMonitor() }));
vi.mock("@/lib/monitor/store", () => ({ monitorStatus: () => monitorStatus() }));

const { GET } = await import("./route");

const SECRET = "tick-secret-for-tests";

function tick(authorization?: string) {
  return new Request("http://localhost/api/monitor/tick", {
    headers: authorization ? { authorization } : {},
  });
}

let saved: string | undefined;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  saved = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
  probeDatabase.mockReset().mockResolvedValue({ ok: true, appliedMigrations: 6 });
  runMonitor.mockReset().mockResolvedValue({ evaluated: true, findings: 1, announced: 1, recovered: 0 });
  monitorStatus.mockReset().mockResolvedValue({ activeAlerts: 2, eventMode: true });
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (saved === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = saved;
  consoleError.mockRestore();
});

describe("GET /api/monitor/tick", () => {
  it("evaluates and reports the open alert count for the right secret", async () => {
    const response = await GET(tick(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok", evaluated: true, activeAlerts: 2, eventMode: true });
    expect(probeDatabase).toHaveBeenCalledWith("monitor/tick");
    expect(runMonitor).toHaveBeenCalledTimes(1);
  });

  it("says so when another evaluation ran moments ago", async () => {
    runMonitor.mockResolvedValue({ evaluated: false });
    const response = await GET(tick(`Bearer ${SECRET}`));
    await expect(response.json()).resolves.toEqual({ status: "ok", evaluated: false, activeAlerts: 2, eventMode: true });
  });

  it.each([
    ["no header", undefined],
    ["a wrong secret", "Bearer not-the-secret"],
    ["the secret without the scheme", SECRET],
    ["an empty bearer", "Bearer "],
  ])("refuses %s without touching the database", async (_, authorization) => {
    const response = await GET(tick(authorization));
    expect(response.status).toBe(401);
    expect(probeDatabase).not.toHaveBeenCalled();
    expect(runMonitor).not.toHaveBeenCalled();
  });

  it("refuses everyone when CRON_SECRET is not set, rather than letting anyone in", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(tick("Bearer "));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "unavailable", reason: "not configured" });
    expect(runMonitor).not.toHaveBeenCalled();
  });

  it("answers 503 with the probe's reason when the database is down, without evaluating", async () => {
    probeDatabase.mockResolvedValue({ ok: false, reason: "database did not answer within 2000ms" });
    const response = await GET(tick(`Bearer ${SECRET}`));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "unavailable",
      reason: "database did not answer within 2000ms",
    });
    expect(runMonitor).not.toHaveBeenCalled();
  });

  it("answers 503 without the error's text when the evaluation fails", async () => {
    runMonitor.mockRejectedValue(new Error("connect ECONNREFUSED postgres://user:pw@host/db"));
    const response = await GET(tick(`Bearer ${SECRET}`));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "unavailable", reason: "evaluation failed" });
  });
});
