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

// The monitor runs after the response, through Next's after(), which needs a
// request scope these direct calls do not have; what matters here is when the
// route asks for it.
const scheduleMonitor = vi.fn();
vi.mock("@/lib/monitor/run", () => ({
  scheduleMonitor: () => scheduleMonitor(),
}));

const { POST } = await import("./route");
const { MAX_EVENTS_BODY_BYTES } = await import("@/lib/events");

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

/** Every v2 field, as rig-agent/0.4-monitor sends it (plan section 4.2). */
const HEARTBEAT_V2 = {
  type: "RIG_HEARTBEAT" as const,
  agentVersion: "rig-agent/0.4-monitor",
  sentAt: "2026-10-04T21:14:08.120Z",
  processStartedAt: "2026-10-04T14:02:11Z",
  startCount: 3,
  osUptimeS: 26_120,
  telemetryMode: "iracing" as const,
  simConnected: true,
  telemetryFaulted: false,
  missingVariables: ["LapLastLapTime"],
  session: {
    trackName: "Circuit of the Americas",
    trackConfig: "Grand Prix",
    carName: "FIA F4",
  },
  assignmentId: "11111111-1111-4111-8111-111111111111" as string | null,
  assignmentKnown: true,
  pendingLaps: 2,
  oldestPendingAgeS: 95,
  rejectedLaps: 1,
  checkout: "queued" as const,
  lastLapCapturedAt: "2026-10-04T21:13:40.000Z",
  lastLapPostedAt: null,
  signInFailures: 4,
  signInFailureKinds: ["wrong_pin_or_name", "locked"],
  notices: ["[agent] the backend will not accept lap 12 (lapTimeMs: Too big)"],
  agentCpuPercent: 0.1,
  agentMemoryMb: 38,
  shuttingDown: false,
  sequence: 7,
};

/** Did the handler try to write a lap, through either db helper? */
function insertedLaps(): boolean {
  return [...query.mock.calls, ...queryOne.mock.calls].some(([sql]) =>
    String(sql).includes("insert into laps"),
  );
}

/** The parameters the heartbeat insert was given, or null if none happened. */
function heartbeatParams(): unknown[] | null {
  const call = [...query.mock.calls, ...queryOne.mock.calls].find(([sql]) =>
    String(sql).includes("insert into rig_heartbeats"),
  );
  return call ? (call[1] as unknown[]) : null;
}

/** Did the handler try to resolve a stamped assignment? */
function lookedUpAssignments(): boolean {
  return [...query.mock.calls, ...queryOne.mock.calls].some(([sql]) =>
    String(sql).includes("rig_assignments"),
  );
}

/** Makes the rig lookup succeed, lap inserts report a new row, and everything
 *  else return nothing. */
function authenticateRig() {
  queryOne.mockImplementation(async (sql: string) => {
    if (sql.includes("from rigs where agent_token_hash")) return RIG;
    if (sql.includes("insert into laps")) return { id: "lap-uuid" };
    if (sql.includes("insert into rig_heartbeats")) return { stored: true };
    return null;
  });
}

/** The parameters the first lap insert was given, or null if none happened. */
function insertParams(): unknown[] | null {
  const call = [...query.mock.calls, ...queryOne.mock.calls].find(([sql]) =>
    String(sql).includes("insert into laps"),
  );
  return call ? (call[1] as unknown[]) : null;
}

/** The (rig_assignment_id, driver_id) pair a lap insert was given. */
function insertedAttribution(): [unknown, unknown] | null {
  const params = insertParams();
  return params ? [params[2], params[3]] : null;
}

/** The unattributed_cause a lap insert was given - the decision under test,
 *  now that the row keeps it rather than only the log line. */
function insertedCause(): unknown {
  return insertParams()?.[13];
}

beforeEach(() => {
  scheduleMonitor.mockReset();
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

  it("rejects a lap time over the ingestion ceiling in the same shape as any other field", async () => {
    const response = await POST(post({ events: [{ ...LAP, lapTimeMs: 7_425_678 }] }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({ error: "invalid_input" });
    // One zod issue, on the field, exactly as a bad completedAt or eventId
    // would report - the agent sees nothing new here.
    expect(body.detail).toEqual([
      expect.objectContaining({ path: ["events", 0, "lapTimeMs"] }),
    ]);
    expect(insertedLaps()).toBe(false);
  });

  it("rejects the whole batch when one lap in it is over the ceiling", async () => {
    // Validation is per body, not per event, so one garbage lap takes its
    // batch-mates down with it - the same as any other malformed field, and
    // the shape the agent's outbox has to cope with. Nothing is written.
    const events = [
      { ...LAP, eventId: "event-00000001" },
      { ...LAP, eventId: "event-00000002", lapTimeMs: 7_425_678 },
      { ...LAP, eventId: "event-00000003" },
    ];

    const response = await POST(post({ events }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.detail).toEqual([
      expect.objectContaining({ path: ["events", 1, "lapTimeMs"] }),
    ]);
    expect(insertedLaps()).toBe(false);
  });

  it.each([
    ["more than ten notices", { notices: Array.from({ length: 11 }, () => "x") }],
    ["a notice over 200 characters", { notices: ["x".repeat(201)] }],
    ["more than ten missing variables", { missingVariables: Array(11).fill("Speed") }],
    ["a count a Postgres int cannot hold", { pendingLaps: 2_147_483_648 }],
    ["a negative count", { rejectedLaps: -1 }],
    ["a fractional count", { startCount: 1.5 }],
    ["an unknown checkout state", { checkout: "pending" }],
    ["an unknown sign-in failure kind", { signInFailureKinds: ["bad_luck"] }],
    ["an unknown telemetry mode", { telemetryMode: "acc" }],
    ["a sentAt without an offset", { sentAt: "2026-10-04T21:14:08" }],
    ["a malformed assignment id", { assignmentId: "not-a-uuid" }],
  ])("rejects a heartbeat with %s", async (_label, field) => {
    const response = await POST(post({ events: [{ ...HEARTBEAT_V2, ...field }] }));

    expect(response.status).toBe(400);
    expect(heartbeatParams()).toBeNull();
  });

  it("rejects a second heartbeat in one request, naming it", async () => {
    const response = await POST(
      post({ events: [{ type: "RIG_HEARTBEAT" }, LAP, { type: "RIG_HEARTBEAT" }] }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.detail).toEqual([expect.objectContaining({ path: ["events", 2] })]);
    expect(heartbeatParams()).toBeNull();
  });

  it("refuses a body over the byte cap before parsing it", async () => {
    // A valid heartbeat beside a megabyte of unknown junk: zod would strip the
    // junk and accept it, so only the byte cap stops it.
    const body = { events: [{ type: "RIG_HEARTBEAT", junk: "x".repeat(MAX_EVENTS_BODY_BYTES) }] };

    const response = await POST(post(body));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "body_too_large" });
    expect(heartbeatParams()).toBeNull();
  });

  it("refuses an oversized body that declares no length", async () => {
    const payload = JSON.stringify({
      events: [{ type: "RIG_HEARTBEAT", junk: "x".repeat(MAX_EVENTS_BODY_BYTES) }],
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });
    const request = new Request("http://localhost/api/agent/events", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: stream,
      duplex: "half",
    } as RequestInit);

    expect((await POST(request)).status).toBe(413);
  });

  it("accepts a full outbox batch at every field's limit", async () => {
    // The cap must never refuse what the agent legitimately sends.
    const events = Array.from({ length: 100 }, (_, index) => ({
      ...LAP,
      eventId: `e${String(index).padStart(7, "0")}`.padEnd(128, "x"),
      rigAssignmentId: null,
      trackName: "\u00fc".repeat(120),
      trackConfig: "\u00fc".repeat(120),
      carName: "\u00fc".repeat(120),
    }));

    // Written the way the agent's System.Text.Json writes it: every non-ASCII
    // character escaped to six bytes, the largest a legitimate batch gets.
    const text = JSON.stringify({ events }).replaceAll("\u00fc", "\\u00fc");
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(200_000);
    const response = await POST(
      new Request("http://localhost/api/agent/events", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: text,
      }),
    );

    expect(response.status).toBe(200);
    expect(insertParams()?.[4]).toBe("\u00fc".repeat(120)); // track_name, unescaped
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

  it("records a v1 heartbeat and reports the agent version", async () => {
    const response = await POST(
      post({ events: [{ type: "RIG_HEARTBEAT", agentVersion: "1.2.3" }] }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      results: [{ type: "RIG_HEARTBEAT", status: "ok" }],
    });

    const params = heartbeatParams()!;
    expect(params[0]).toBe(RIG.id);
    expect(params[2]).toBe("1.2.3"); // agent_version, also coalesced onto rigs
    // Everything a v1 agent cannot say is stored as not said.
    expect(params.slice(3, 15).every((value) => value === null)).toBe(true);
    expect(params[15]).toBe(false); // shutting_down
    expect(params[16]).toEqual({}); // payload
  });

  it("stores a heartbeat that carries nothing but its type", async () => {
    // The oldest shape on the wire. Refusing it would make that rig read as
    // silent to the monitor, which is the one thing it can still tell us about.
    const response = await POST(post({ events: [{ type: "RIG_HEARTBEAT" }] }));

    expect(response.status).toBe(200);
    const params = heartbeatParams()!;
    expect(params[1]).toBeNull(); // sent_at, so no clock skew either
    expect(params[2]).toBeNull();
    expect(params[16]).toEqual({});
  });

  it("splits a v2 heartbeat into its columns and keeps the rest as payload", async () => {
    const response = await POST(post({ events: [HEARTBEAT_V2] }));

    expect(response.status).toBe(200);
    expect(heartbeatParams()).toEqual([
      RIG.id,
      HEARTBEAT_V2.sentAt,
      HEARTBEAT_V2.agentVersion,
      HEARTBEAT_V2.processStartedAt,
      3,
      true,
      false,
      "Circuit of the Americas",
      "Grand Prix",
      "FIA F4",
      ASSIGNMENT_ID,
      2,
      1,
      "queued",
      4,
      false,
      {
        osUptimeS: 26_120,
        telemetryMode: "iracing",
        missingVariables: ["LapLastLapTime"],
        assignmentKnown: true,
        oldestPendingAgeS: 95,
        lastLapCapturedAt: "2026-10-04T21:13:40.000Z",
        lastLapPostedAt: null,
        signInFailureKinds: ["wrong_pin_or_name", "locked"],
        notices: ["[agent] the backend will not accept lap 12 (lapTimeMs: Too big)"],
        agentCpuPercent: 0.1,
        agentMemoryMb: 38,
        sequence: 7,
      },
      6, // heartbeat rate limit
      "1 minute", // and its window
    ]);
  });

  it("asks for a monitor evaluation after every heartbeat, and only then", async () => {
    await POST(post({ events: [HEARTBEAT_V2] }));
    expect(scheduleMonitor).toHaveBeenCalledTimes(1);

    scheduleMonitor.mockReset();
    await POST(post({ events: [LAP] }));
    expect(scheduleMonitor).not.toHaveBeenCalled();

    // A refused body stores nothing, so there is nothing new to judge.
    await POST(post({ events: [{ ...HEARTBEAT_V2, pendingLaps: -1 }] }));
    expect(scheduleMonitor).not.toHaveBeenCalled();
  });

  it("marks the rig seen once per heartbeat, in the heartbeat's own statement", async () => {
    await POST(post({ events: [HEARTBEAT_V2] }));

    const rigUpdates = [...query.mock.calls, ...queryOne.mock.calls].filter(([sql]) =>
      String(sql).includes("update rigs set last_seen_at"),
    );
    expect(rigUpdates).toHaveLength(1);
  });

  it("still marks the rig seen after a batch of laps alone", async () => {
    await POST(post({ events: [{ ...LAP, rigAssignmentId: null }] }));

    const rigUpdates = [...query.mock.calls, ...queryOne.mock.calls].filter(([sql]) =>
      String(sql).includes("update rigs set last_seen_at"),
    );
    expect(rigUpdates).toHaveLength(1);
  });

  it("answers a heartbeat over the rig's rate as rate_limited, not an error", async () => {
    queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("from rigs where agent_token_hash")) return RIG;
      if (sql.includes("insert into rig_heartbeats")) return { stored: false };
      return null;
    });

    const response = await POST(post({ events: [HEARTBEAT_V2] }));

    // 200 so a lap riding in the same batch is never refused for it.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      results: [{ type: "RIG_HEARTBEAT", status: "rate_limited" }],
    });
  });

  it("stores the goodbye an exiting agent sends", async () => {
    await POST(post({ events: [{ type: "RIG_HEARTBEAT", shuttingDown: true }] }));

    expect(heartbeatParams()![15]).toBe(true);
  });

  it("stores an idle rig's heartbeat with no session", async () => {
    await POST(
      post({ events: [{ ...HEARTBEAT_V2, session: null, assignmentId: null }] }),
    );

    const params = heartbeatParams()!;
    expect(params.slice(7, 11)).toEqual([null, null, null, null]);
  });

  it("stores a lap from an agent that sends no assignment id with no owner", async () => {
    // LAP has no rigAssignmentId: the shape an agent built before the field
    // existed still sends. It must never fall back to a live lookup.
    const response = await POST(post({ events: [LAP] }));

    await expect(response.json()).resolves.toEqual({
      results: [
        {
          type: "LAP_COMPLETED",
          eventId: LAP.eventId,
          status: "accepted_unattributed",
        },
      ],
    });
    expect(insertedLaps()).toBe(true);
    expect(insertedAttribution()).toEqual([null, null]);
    expect(insertedCause()).toBe("agent_sends_no_assignment_id");
    // Not even asked - there is no assignment this lap could belong to.
    expect(lookedUpAssignments()).toBe(false);
  });

  it("stores a lap the agent captured with nobody checked in with no owner", async () => {
    const response = await POST(post({ events: [{ ...LAP, rigAssignmentId: null }] }));

    await expect(response.json()).resolves.toEqual({
      results: [
        {
          type: "LAP_COMPLETED",
          eventId: LAP.eventId,
          status: "accepted_unattributed",
        },
      ],
    });
    expect(insertedAttribution()).toEqual([null, null]);
    expect(insertedCause()).toBe("nobody_checked_in");
    expect(lookedUpAssignments()).toBe(false);
  });

  it("marks an unattributed lap invalid so it can never rank", async () => {
    await POST(post({ events: [{ ...LAP, rigAssignmentId: null }] }));

    const call = [...query.mock.calls, ...queryOne.mock.calls].find(([sql]) =>
      String(sql).includes("insert into laps"),
    )!;
    const params = call[1] as unknown[];
    expect(params[10]).toBe(false); // is_valid
    expect(params[11]).toBe("UNATTRIBUTED"); // invalid_reason
  });

  it("looks up stamped assignments once per batch, scoped to the rig", async () => {
    const events = [
      { ...LAP, eventId: "event-00000001", rigAssignmentId: ASSIGNMENT_ID },
      { ...LAP, eventId: "event-00000002", rigAssignmentId: ASSIGNMENT_ID },
      { ...LAP, eventId: "event-00000003", rigAssignmentId: OTHER_ASSIGNMENT_ID },
    ];

    await POST(post({ events }));

    const lookups = query.mock.calls.filter(([sql]) =>
      String(sql).includes("rig_assignments"),
    );
    expect(lookups).toHaveLength(1);
    // The rig comes from the bearer token, and each lap carries the id it
    // stamped alongside the moment it was driven, so the window check below
    // can be made per lap rather than per assignment. Laps are identified by
    // their POSITION in the batch, not their eventId - a batch may repeat an
    // eventId, and two entries sharing one would otherwise share a verdict.
    expect(lookups[0]![1]).toEqual([
      RIG.id,
      [0, 1, 2],
      [ASSIGNMENT_ID, ASSIGNMENT_ID, OTHER_ASSIGNMENT_ID],
      [LAP.completedAt, LAP.completedAt, LAP.completedAt],
      "15 minutes",
    ]);
  });

  it("bounds the lookup by the assignment's own window, with a skew grace", async () => {
    await POST(post({ events: [{ ...LAP, rigAssignmentId: ASSIGNMENT_ID }] }));

    const [sql, params] = query.mock.calls.find(([text]) =>
      String(text).includes("rig_assignments"),
    )!;
    // The window predicate is the guard: without it a rig token could name any
    // assignment that rig has ever held and pick its driver.
    expect(String(sql)).toContain("a.started_at");
    expect(String(sql)).toContain("a.ended_at");
    // The grace is a named constant, passed in rather than written into the SQL.
    expect(String(sql)).not.toContain("15 minutes");
    expect(params).toContain("15 minutes");
  });

  it("stores a lap driven outside the window of the assignment it names with no owner", async () => {
    // lap_index, not event_id: matches are keyed by batch position. Getting this
    // wrong would make the lookup miss and the case pass as unknown_assignment
    // instead, which produces the same status - hence the cause and warn
    // assertions below, which are what tell the two causes apart.
    query.mockImplementation(async (sql: string) =>
      String(sql).includes("rig_assignments")
        ? [
            {
              lap_index: 0,
              id: ASSIGNMENT_ID,
              driver_id: "driver-uuid",
              in_window: false,
            },
          ]
        : [],
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await POST(
      post({ events: [{ ...LAP, rigAssignmentId: ASSIGNMENT_ID }] }),
    );

    await expect(response.json()).resolves.toEqual({
      results: [
        {
          type: "LAP_COMPLETED",
          eventId: LAP.eventId,
          status: "accepted_unattributed",
        },
      ],
    });
    // The rig HAS this assignment, so the refusal must be the window one - not
    // the "never owned it" one that an index mismatch would produce.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("falls outside the assignment"));
    warn.mockRestore();
    // Stored, not dropped - but the driver it named is never credited.
    expect(insertedLaps()).toBe(true);
    expect(insertedAttribution()).toEqual([null, null]);
    expect(insertedCause()).toBe("outside_assignment_window");
  });

  it("stores a lap naming an assignment that is not this rig's with no owner", async () => {
    // The scoped lookup comes back empty, so there is nothing to attribute to -
    // and the currently-open assignment is never consulted as a fallback.
    const response = await POST(
      post({ events: [{ ...LAP, rigAssignmentId: ASSIGNMENT_ID }] }),
    );

    await expect(response.json()).resolves.toEqual({
      results: [
        {
          type: "LAP_COMPLETED",
          eventId: LAP.eventId,
          status: "accepted_unattributed",
        },
      ],
    });
    expect(insertedAttribution()).toEqual([null, null]);
    expect(insertedCause()).toBe("unknown_assignment");
  });

  it("attributes a lap to the assignment the agent stamped on it", async () => {
    query.mockImplementation(async (sql: string) =>
      String(sql).includes("rig_assignments")
        ? [
            {
              lap_index: 0,
              id: ASSIGNMENT_ID,
              driver_id: "driver-uuid",
              in_window: true,
            },
          ]
        : [],
    );

    const response = await POST(
      post({ events: [{ ...LAP, rigAssignmentId: ASSIGNMENT_ID }] }),
    );

    await expect(response.json()).resolves.toEqual({
      results: [{ type: "LAP_COMPLETED", eventId: LAP.eventId, status: "accepted" }],
    });
    expect(insertedAttribution()).toEqual([ASSIGNMENT_ID, "driver-uuid"]);
    // An owned lap has no cause - the database rejects one that does.
    expect(insertedCause()).toBeNull();
  });

  it("attributes a stamped lap that follows a heartbeat in the same batch", async () => {
    // Matches are keyed by position in the FULL event array, and attributeLap
    // reads that same index. Every other case here sends laps only, so the two
    // indexes coincide and an off-by-one from keying on the filtered lap
    // position would pass the whole suite - while misattributing every real
    // batch that opens with a heartbeat, which is the shape the agent actually
    // sends. The heartbeat below is what makes the two indexes differ.
    query.mockImplementation(async (sql: string) =>
      String(sql).includes("rig_assignments")
        ? [
            {
              lap_index: 1,
              id: ASSIGNMENT_ID,
              driver_id: "driver-uuid",
              in_window: true,
            },
          ]
        : [],
    );

    const response = await POST(
      post({
        events: [
          { type: "RIG_HEARTBEAT", agentVersion: "rig-agent/0.2-skeleton" },
          { ...LAP, rigAssignmentId: ASSIGNMENT_ID },
        ],
      }),
    );

    await expect(response.json()).resolves.toEqual({
      results: [
        { type: "RIG_HEARTBEAT", status: "ok" },
        { type: "LAP_COMPLETED", eventId: LAP.eventId, status: "accepted" },
      ],
    });
    expect(insertedAttribution()).toEqual([ASSIGNMENT_ID, "driver-uuid"]);

    // The id the lookup asked about is the lap's index in the whole batch.
    const lookup = query.mock.calls.find(([sql]) =>
      String(sql).includes("rig_assignments"),
    )!;
    expect((lookup[1] as unknown[])[1]).toEqual([1]);
  });

  it("rejects a malformed assignment id rather than ignoring it", async () => {
    expect(
      (await POST(post({ events: [{ ...LAP, rigAssignmentId: "not-a-uuid" }] }))).status,
    ).toBe(400);
  });

  it("returns 500 so the agent retries when the batch throws", async () => {
    queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("from rigs where agent_token_hash")) return RIG;
      throw new Error("connection terminated");
    });

    const response = await POST(post({ events: [{ type: "RIG_HEARTBEAT" }] }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "server_error" });
  });
});
