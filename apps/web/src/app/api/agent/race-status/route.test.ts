import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

/**
 * Unit coverage for the branches that need no database: authentication, the
 * body ceiling, the contract's bounds, and the failure path. The upsert itself
 * is covered against real Postgres in src/app/api/race/live/route.integration.test.ts.
 */

const query = vi.fn();
const queryOne = vi.fn();

vi.mock("@/lib/db", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
}));

const { POST } = await import("./route");
const { MAX_RACE_STATUS_BODY_BYTES } = await import("@/lib/events");

const RIG = { id: "rig-uuid", rig_number: 7, display_name: "Rig 07" };
const TOKEN = "agent-token";
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");

const REPORT = {
  sampledAt: "2026-10-07T19:30:00.000-05:00",
  sessionUniqueId: 81_234_567,
  sessionNum: 2,
  sessionType: "Race",
  sessionState: 4,
  sessionFlags: 0x8000_0004,
  sessionTimeRemainS: 1_200.5,
  sessionLapsRemain: null,
  carIdx: 12,
  position: 3,
  classPosition: 3,
  lap: 5,
  lapsCompleted: 4,
  lapDistPct: 0.42,
  gapToLeaderS: 3.25,
  lastLapMs: 138_210,
  bestLapMs: 137_904,
  onPitRoad: false,
  incidents: 2,
};

function post(body: unknown, authorization: string | null = `Bearer ${TOKEN}`) {
  return new Request("http://localhost/api/agent/race-status", {
    method: "POST",
    headers: authorization ? { authorization } : {},
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/agent/race-status", () => {
  beforeEach(() => {
    query.mockReset().mockResolvedValue([]);
    queryOne.mockReset().mockImplementation(async (_sql: string, params: unknown[]) =>
      params[0] === TOKEN_HASH ? RIG : null,
    );
  });

  it("refuses a missing or unknown token before reading anything", async () => {
    expect((await POST(post(REPORT, null))).status).toBe(401);
    expect((await POST(post(REPORT, "Bearer someone-else"))).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it("stores the report against the token's own rig and answers 200 with no body", async () => {
    const res = await POST(post(REPORT));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toMatch(/on conflict \(rig_id\) do update/);
    expect(params[0]).toBe(RIG.id);
    expect(params).toContain(0x8000_0004);
  });

  it("accepts the nulls that stand for iRacing's sentinels", async () => {
    const res = await POST(
      post({
        ...REPORT,
        sessionType: null,
        sessionTimeRemainS: null,
        sessionLapsRemain: null,
        position: null,
        classPosition: null,
        lap: null,
        lapsCompleted: null,
        lapDistPct: null,
        gapToLeaderS: null,
        lastLapMs: null,
        bestLapMs: null,
      }),
    );
    expect(res.status).toBe(200);
  });

  it("accepts remaining time and laps just under the unlimited sentinels", async () => {
    const res = await POST(post({ ...REPORT, sessionTimeRemainS: 604_799.9, sessionLapsRemain: 32_766 }));
    expect(res.status).toBe(200);
  });

  it.each([
    ["a position of 0, iRacing's unclassified", { position: 0 }],
    ["a position past a full field", { position: 65 }],
    ["a car index past the last slot", { carIdx: 64 }],
    ["a session state iRacing does not have", { sessionState: 7 }],
    ["flags read as a signed int", { sessionFlags: -2_147_483_644 }],
    ["iRacing's -1 lap time", { lastLapMs: -1 }],
    ["a lap distance past the line", { lapDistPct: 1.2 }],
    ["iRacing's unlimited time sentinel itself, which must be sent as null", { sessionTimeRemainS: 604_800 }],
    ["a time remaining past the unlimited sentinel", { sessionTimeRemainS: 604_801 }],
    ["iRacing's unlimited laps sentinel itself, which must be sent as null", { sessionLapsRemain: 32_767 }],
    ["a negative gap", { gapToLeaderS: -0.1 }],
    ["a missing pit flag", { onPitRoad: undefined }],
    ["a missing sample time", { sampledAt: undefined }],
  ])("refuses %s", async (_name, change) => {
    const res = await POST(post({ ...REPORT, ...change }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_input" });
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON", async () => {
    expect((await POST(post("{not json"))).status).toBe(400);
  });

  it("refuses an oversized body without parsing it", async () => {
    const res = await POST(post({ ...REPORT, padding: "x".repeat(MAX_RACE_STATUS_BODY_BYTES) }));

    expect(res.status).toBe(413);
    expect(query).not.toHaveBeenCalled();
  });

  it("answers 500 when the write fails, which the agent drops rather than retries", async () => {
    query.mockRejectedValueOnce(new Error("relation \"rig_race_status\" does not exist"));
    vi.spyOn(console, "error").mockImplementationOnce(() => {});

    expect((await POST(post(REPORT))).status).toBe(500);
  });
});
