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

const RIG = { id: "rig-uuid", rig_number: 1, display_name: "Rig 01" };
const TOKEN = "agent-token";
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");

function post(body: unknown, authorization: string | null = `Bearer ${TOKEN}`) {
  return new Request("http://localhost/api/agent/events", {
    method: "POST",
    headers: authorization ? { authorization } : {},
    body: JSON.stringify(body),
  });
}

const ASSIGNMENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ASSIGNMENT_ID = "22222222-2222-4222-8222-222222222222";

const LAP = {
  type: "LAP_COMPLETED" as const,
  eventId: "event-00000001",
  trackName: "Spa-Francorchamps",
  carName: "Porsche 911 GT3 R",
  lapTimeMs: 138_103,
  incidentDelta: 0,
  completedAt: "2026-07-29T02:00:00.000Z",
};

/** Did the handler try to write a lap, through either db helper? */
function insertedLaps(): boolean {
  return [...query.mock.calls, ...queryOne.mock.calls].some(([sql]) =>
    String(sql).includes("insert into laps"),
  );
}

/** Did the handler try to resolve a stamped assignment? */
function lookedUpAssignments(): boolean {
  return [...query.mock.calls, ...queryOne.mock.calls].some(([sql]) =>
    String(sql).includes("from rig_assignments"),
  );
}

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

  it("records a heartbeat and reports the agent version", async () => {
    const response = await POST(
      post({ events: [{ type: "RIG_HEARTBEAT", agentVersion: "1.2.3" }] }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      results: [{ type: "RIG_HEARTBEAT", status: "ok" }],
    });

    const versionUpdate = query.mock.calls.find(([sql]) =>
      String(sql).includes("agent_version"),
    );
    expect(versionUpdate?.[1]).toEqual([RIG.id, "1.2.3"]);
  });

  it("refuses a lap from an agent that sends no assignment id", async () => {
    // LAP has no rigAssignmentId: the shape an agent built before the field
    // existed still sends. It must never fall back to a live lookup.
    const response = await POST(post({ events: [LAP] }));

    await expect(response.json()).resolves.toEqual({
      results: [
        {
          type: "LAP_COMPLETED",
          eventId: LAP.eventId,
          status: "attribution_unsupported",
        },
      ],
    });
    expect(insertedLaps()).toBe(false);
    // Not even asked - there is no assignment this lap could belong to.
    expect(lookedUpAssignments()).toBe(false);
  });

  it("refuses a lap the agent captured with nobody checked in", async () => {
    const response = await POST(
      post({ events: [{ ...LAP, rigAssignmentId: null }] }),
    );

    await expect(response.json()).resolves.toEqual({
      results: [
        { type: "LAP_COMPLETED", eventId: LAP.eventId, status: "no_active_assignment" },
      ],
    });
    expect(insertedLaps()).toBe(false);
    expect(lookedUpAssignments()).toBe(false);
  });

  it("looks up stamped assignments once per batch, scoped to the rig", async () => {
    const events = [
      { ...LAP, eventId: "event-00000001", rigAssignmentId: ASSIGNMENT_ID },
      { ...LAP, eventId: "event-00000002", rigAssignmentId: ASSIGNMENT_ID },
      { ...LAP, eventId: "event-00000003", rigAssignmentId: OTHER_ASSIGNMENT_ID },
    ];

    await POST(post({ events }));

    const lookups = query.mock.calls.filter(([sql]) =>
      String(sql).includes("from rig_assignments"),
    );
    expect(lookups).toHaveLength(1);
    // The rig comes from the bearer token, and each distinct id is asked for once.
    expect(lookups[0]![1]).toEqual([RIG.id, [ASSIGNMENT_ID, OTHER_ASSIGNMENT_ID]]);
  });

  it("refuses a stamped assignment that does not belong to this rig", async () => {
    // The scoped lookup comes back empty, so there is nothing to attribute to.
    const response = await POST(
      post({ events: [{ ...LAP, rigAssignmentId: ASSIGNMENT_ID }] }),
    );

    await expect(response.json()).resolves.toEqual({
      results: [
        { type: "LAP_COMPLETED", eventId: LAP.eventId, status: "unknown_assignment" },
      ],
    });
    expect(insertedLaps()).toBe(false);
  });

  it("rejects a malformed assignment id rather than ignoring it", async () => {
    expect(
      (await POST(post({ events: [{ ...LAP, rigAssignmentId: "not-a-uuid" }] }))).status,
    ).toBe(400);
  });

  it("returns 500 so the agent retries when the batch throws", async () => {
    query.mockRejectedValue(new Error("connection terminated"));

    const response = await POST(post({ events: [{ type: "RIG_HEARTBEAT" }] }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "server_error" });
  });
});
