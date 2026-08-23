import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

/**
 * Unit coverage for the branches that need no database: authentication,
 * input validation, and the failure path. The guarantees that live in SQL
 * (idempotency, attribution, races) are covered in route.integration.test.ts.
 */

const query = vi.fn();
const queryOne = vi.fn();

vi.mock("@/lib/db", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  isUniqueViolation: () => false,
}));

const { POST } = await import("./route");

const RIG = {
  id: "rig-uuid",
  rig_number: 1,
  display_name: "Rig 01",
  installation_conflict: false,
  installation_conflict_detail: null,
};
const TOKEN = "agent-token";
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");

function post(body: unknown, authorization: string | null = `Bearer ${TOKEN}`) {
  return new Request("http://localhost/api/agent/events", {
    method: "POST",
    headers: authorization ? { authorization } : {},
    body: JSON.stringify(body),
  });
}

const LAP = {
  type: "LAP_COMPLETED" as const,
  eventId: "event-00000001",
  trackName: "Spa-Francorchamps",
  carName: "Porsche 911 GT3 R",
  lapTimeMs: 138_103,
  incidentDelta: 0,
  completedAt: "2026-07-29T02:00:00.000Z",
};

/** Makes the rig lookup succeed and everything else return nothing. */
function authenticateRig() {
  queryOne.mockImplementation(async (sql: string) => {
    if (sql.includes("from rigs where agent_token_hash")) return RIG;
    return null;
  });
}

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  query.mockResolvedValue([]);
  queryOne.mockResolvedValue(null);
});

describe("POST /api/agent/events authentication", () => {
  it("rejects a missing Authorization header without touching the database", async () => {
    const response = await POST(post({ events: [LAP] }, null));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(queryOne).not.toHaveBeenCalled();
  });

  it("rejects a non-Bearer scheme", async () => {
    const response = await POST(post({ events: [LAP] }, `Basic ${TOKEN}`));

    expect(response.status).toBe(401);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it("rejects an unknown token", async () => {
    queryOne.mockResolvedValue(null);

    const response = await POST(post({ events: [LAP] }));

    expect(response.status).toBe(401);
  });

  it("looks the rig up by sha256 of the token, never the raw token", async () => {
    authenticateRig();

    await POST(post({ events: [{ type: "RIG_HEARTBEAT" }] }));

    const [, params] = queryOne.mock.calls[0]!;
    expect(params).toEqual([TOKEN_HASH]);
    expect(JSON.stringify(params)).not.toContain(TOKEN);
  });
});

describe("POST /api/agent/events validation", () => {
  beforeEach(authenticateRig);

  it("rejects a malformed body", async () => {
    const response = await POST(post({ nope: true }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_input" });
  });

  it("rejects an empty event list", async () => {
    expect((await POST(post({ events: [] }))).status).toBe(400);
  });

  it("rejects a batch over the 100-event cap", async () => {
    const events = Array.from({ length: 101 }, (_, index) => ({
      ...LAP,
      eventId: `event-${String(index).padStart(8, "0")}`,
    }));

    expect((await POST(post({ events }))).status).toBe(400);
  });

  it("rejects a non-positive lap time", async () => {
    expect((await POST(post({ events: [{ ...LAP, lapTimeMs: 0 }] }))).status).toBe(400);
  });

  it("rejects a negative incident delta", async () => {
    expect((await POST(post({ events: [{ ...LAP, incidentDelta: -1 }] }))).status).toBe(
      400,
    );
  });

  it("rejects a completedAt without an offset", async () => {
    expect(
      (await POST(post({ events: [{ ...LAP, completedAt: "2026-07-29T02:00:00" }] })))
        .status,
    ).toBe(400);
  });

  it("rejects an eventId shorter than the idempotency-key minimum", async () => {
    expect((await POST(post({ events: [{ ...LAP, eventId: "short" }] }))).status).toBe(
      400,
    );
  });
});

describe("POST /api/agent/events behaviour", () => {
  beforeEach(authenticateRig);

  it("refuses to attribute a lap while two computers share the rig's token", async () => {
    queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("from rigs where agent_token_hash"))
        return { ...RIG, installation_conflict: true, installation_conflict_detail: "RIG-03 and RIG-07" };
      return null;
    });

    const response = await POST(post({ events: [LAP] }));

    // No assignment is looked up and nothing is inserted: there is no honest
    // answer to whose lap this is, so the agent keeps it queued instead.
    await expect(response.json()).resolves.toEqual({
      results: [{ type: "LAP_COMPLETED", status: "rig_conflict", eventId: LAP.eventId }],
    });
    expect(
      queryOne.mock.calls.some(([sql]) => String(sql).includes("rig_assignments")),
    ).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("insert into laps"))).toBe(
      false,
    );
  });

  it("records a heartbeat and reports the agent version", async () => {
    const response = await POST(
      post({ events: [{ type: "RIG_HEARTBEAT", agentVersion: "1.2.3" }] }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      results: [{ type: "RIG_HEARTBEAT", status: "ok" }],
    });

    // An agent too old to report its simulator writes nulls, not nothing: the
    // dashboard must read it as unknown rather than keeping the last verdict.
    const versionUpdate = query.mock.calls.find(([sql]) =>
      String(sql).includes("agent_version"),
    );
    expect(versionUpdate?.[1]).toEqual([RIG.id, "1.2.3", null, null, null, null]);
  });

  it("drops an explanation that does not belong to the verdict it came with", async () => {
    // A stale detail beside a healthy rig sends staff after a fault that is
    // fixed; the agent already suppresses it, and the backend does not take the
    // agent's word for it.
    await POST(
      post({
        events: [
          {
            type: "RIG_HEARTBEAT",
            simHealth: "scoring",
            simHealthDetail: "the simulator does not publish OnPitRoad",
          },
        ],
      }),
    );

    const update = query.mock.calls.find(([sql]) => String(sql).includes("sim_health"));
    expect(update?.[1]).toEqual([RIG.id, null, "scoring", null, null, null]);
  });

  it("refuses to guess an owner when no assignment is open", async () => {
    // queryOne returns the rig for auth and null for the assignment lookup.
    const response = await POST(post({ events: [LAP] }));

    await expect(response.json()).resolves.toEqual({
      results: [
        { type: "LAP_COMPLETED", eventId: LAP.eventId, status: "no_active_assignment" },
      ],
    });
    // Nothing was inserted, through either db helper.
    const allSql = [...query.mock.calls, ...queryOne.mock.calls].map(([sql]) =>
      String(sql),
    );
    expect(allSql.some((sql) => sql.includes("insert into laps"))).toBe(false);
  });

  it("returns 500 so the agent retries when the batch throws", async () => {
    query.mockRejectedValue(new Error("connection terminated"));

    const response = await POST(post({ events: [{ type: "RIG_HEARTBEAT" }] }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "server_error" });
  });
});
