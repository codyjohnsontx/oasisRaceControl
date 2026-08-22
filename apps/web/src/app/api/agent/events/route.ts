import { query, queryOne } from "@/lib/db";
import { rigFromBearer } from "@/lib/agent-auth";
import {
  agentEventsBody,
  statesCaptureTimeAttribution,
  type AgentEventsBody,
  type LapCompletedEvent,
} from "@/lib/events";
import { computeValidity, type FeaturedCombo } from "@/lib/validity";
import { venueToday } from "@/lib/venue";

/**
 * Idempotent agent event ingestion.
 *
 * PROVISIONAL CONTRACT: the event shape (src/lib/events.ts) may change when
 * the Phase 1 spike findings land (docs/spike-findings.md). Two clients speak
 * it and both change with it: the C# Rig Agent (apps/rig-agent) and the
 * fake-rig simulator (scripts/fake-rig.ts).
 *
 * Attribution comes from the rigAssignmentId the agent stamped on each lap when
 * it captured it, never from the rig's currently-open assignment - a queued lap
 * can arrive long after its driver has left. A lap that cannot be attributed is
 * stored with no driver and no assignment, invalid and unrankable, rather than
 * being credited to the next driver or dropped (db/migrations/0003).
 */
export async function POST(request: Request) {
  const rig = await rigFromBearer(request.headers.get("authorization"));
  if (!rig) return Response.json({ error: "unauthorized" }, { status: 401 });

  const parsed = agentEventsBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_input", detail: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    // Tonight's combo applies to the whole batch — look it up once, not per lap.
    let combo: FeaturedCombo | null = null;
    if (parsed.data.events.some((event) => event.type === "LAP_COMPLETED")) {
      combo = await queryOne<FeaturedCombo>(
        `select track_name, track_config, car_name, incident_limit
         from featured_combos where combo_date = $1`,
        [venueToday()],
      );
    }
    const matches = await loadStampedAssignments(rig.id, parsed.data.events);

    const results: Array<{ type: string; status: string; eventId?: string }> = [];
    const causes: UnattributedCause[] = [];

    for (const [index, event] of parsed.data.events.entries()) {
      if (event.type === "RIG_HEARTBEAT") {
        await query(
          `update rigs set last_seen_at = now(),
             agent_version = coalesce($2, agent_version)
           where id = $1`,
          [rig.id, event.agentVersion ?? null],
        );
        results.push({ type: event.type, status: "ok" });
      } else {
        const attribution = attributeLap(event, index, matches);
        if (attribution.kind === "unattributed") causes.push(attribution.cause);
        results.push(await ingestLap(rig.id, event, combo, attribution));
      }
    }
    warnAboutAbnormalCauses(rig.rig_number, causes);

    // Any activity proves the agent is alive.
    await query("update rigs set last_seen_at = now() where id = $1", [rig.id]);

    return Response.json({ results });
  } catch (error) {
    // The agent queues and retries on failure, so a 500 here is safe — its
    // idempotency keys keep the retry from double-inserting.
    console.error("[agent/events] batch failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}

type StampedAssignment = { id: string; driver_id: string };

/** What the batch's stamped assignment ids resolved to, per lap. */
type AssignmentMatch = { assignment: StampedAssignment; inWindow: boolean };

/**
 * Allowance for genuine drift between a rig PC's clock and the server's when
 * checking a lap against the window of the assignment it names.
 *
 * This is NOT a business rule and NOT slack for laps that arrive late: a lap
 * that waited out an outage still carries the completedAt it was driven at,
 * which already falls inside its own assignment's window however long the
 * flush took. It exists only so a rig whose clock is a few minutes off does not
 * lose its driver. Widening it widens what a stolen rig token can claim, so it
 * is a tolerance, not a tunable policy knob.
 */
const ASSIGNMENT_WINDOW_CLOCK_SKEW = "15 minutes";

/**
 * Resolves the assignment each stamped lap names, in one query, scoped to the
 * calling rig - the same "look it up once, not per lap" shape as tonight's
 * combo. An id belonging to another rig simply does not come back, so the
 * rig-scoping rule lives here and nowhere else.
 *
 * Open or closed is deliberately not part of the lookup. A lap that sat in the
 * outbox through a network outage still belongs to the driver who drove it, and
 * their assignment has usually closed by the time it lands; refusing it there
 * would throw away the backlog the durable outbox exists to protect.
 *
 * The assignment's time WINDOW is part of it, though. completedAt is supplied
 * by the agent, so without this a rig's bearer token could name any assignment
 * that rig has ever held and credit a months-old driver with a lap they never
 * drove. A lap only attaches to an assignment that was actually running when it
 * was driven, give or take ASSIGNMENT_WINDOW_CLOCK_SKEW.
 *
 * Keyed by each lap's POSITION in the batch, never by its eventId. A batch may
 * legitimately repeat an eventId - that is what the idempotency key is for - but
 * a crafted one could repeat it with a different assignment or completedAt, and
 * keying by eventId would let the last entry's window verdict decide the first
 * entry's owner. That would turn the guard above into one a caller can talk its
 * way around. Position is unique per row by construction.
 */
async function loadStampedAssignments(
  rigId: string,
  events: AgentEventsBody["events"],
): Promise<Map<number, AssignmentMatch>> {
  const stamped = events.flatMap((event, index) =>
    event.type === "LAP_COMPLETED" && event.rigAssignmentId
      ? [{ index, id: event.rigAssignmentId, at: event.completedAt }]
      : [],
  );
  if (stamped.length === 0) return new Map();

  const rows = await query<StampedAssignment & { lap_index: number; in_window: boolean }>(
    `select lap.lap_index, a.id, a.driver_id,
            lap.completed_at >= a.started_at - $5::interval
              and lap.completed_at < coalesce(a.ended_at, 'infinity'::timestamptz) + $5::interval
              as in_window
     from unnest($2::int[], $3::uuid[], $4::timestamptz[])
       as lap (lap_index, assignment_id, completed_at)
     join rig_assignments a on a.id = lap.assignment_id and a.rig_id = $1`,
    [
      rigId,
      stamped.map((lap) => lap.index),
      stamped.map((lap) => lap.id),
      stamped.map((lap) => lap.at),
      ASSIGNMENT_WINDOW_CLOCK_SKEW,
    ],
  );
  return new Map(
    rows.map((row) => [
      row.lap_index,
      { assignment: { id: row.id, driver_id: row.driver_id }, inWindow: row.in_window },
    ]),
  );
}

/** Why a lap ended up with no owner. Three of the four are operator problems. */
type UnattributedCause =
  | "nobody_checked_in"
  | "agent_sends_no_assignment_id"
  | "unknown_assignment"
  | "outside_assignment_window";

type Attribution =
  | { kind: "attributed"; assignment: StampedAssignment }
  | { kind: "unattributed"; cause: UnattributedCause };

/**
 * Who owns this lap, decided only from what the agent stamped on it at capture
 * time. Reading the rig's currently-open assignment here is the defect this
 * replaces: a lap driven at 18:40 with nobody checked in was credited to
 * whoever checked in at 18:41.
 */
function attributeLap(
  lap: LapCompletedEvent,
  lapIndex: number,
  matches: Map<number, AssignmentMatch>,
): Attribution {
  // An agent too old to stamp its laps. It cannot say who was driving, and we
  // will not guess - even though an assignment may well have been open.
  if (!statesCaptureTimeAttribution(lap)) {
    return { kind: "unattributed", cause: "agent_sends_no_assignment_id" };
  }
  // The agent knew the rig was unassigned. Nobody owns this lap and nobody
  // ever will: there is no later moment at which the system learns who drove.
  if (lap.rigAssignmentId == null) {
    return { kind: "unattributed", cause: "nobody_checked_in" };
  }
  // Unknown to this rig: a stale outbox from a rebuilt database, or one rig's
  // token quoting another rig's assignment. Never falls back to a live lookup.
  const match = matches.get(lapIndex);
  if (!match) return { kind: "unattributed", cause: "unknown_assignment" };
  // Real assignment, wrong moment: the driver it names was not in that seat
  // when this lap was driven, so crediting them would be the same invented
  // attribution this whole path exists to prevent.
  if (!match.inWindow) {
    return { kind: "unattributed", cause: "outside_assignment_window" };
  }

  return { kind: "attributed", assignment: match.assignment };
}

/** Three of the four causes mean somebody has to go fix something. The fourth -
 *  a rig driven by nobody checked in - is ordinary venue life, not an error. */
function warnAboutAbnormalCauses(rigNumber: number, causes: UnattributedCause[]): void {
  const stale = causes.filter((c) => c === "agent_sends_no_assignment_id").length;
  if (stale > 0) {
    console.warn(
      `[agent/events] rig ${rigNumber}: stored ${stale} lap(s) unattributed - this ` +
        `agent sends no rigAssignmentId, so nothing it records can reach a ` +
        `leaderboard. Update the rig agent.`,
    );
  }
  const unknown = causes.filter((c) => c === "unknown_assignment").length;
  if (unknown > 0) {
    console.warn(
      `[agent/events] rig ${rigNumber}: stored ${unknown} lap(s) unattributed - the ` +
        `assignment id they carry does not belong to this rig.`,
    );
  }
  const outOfWindow = causes.filter((c) => c === "outside_assignment_window").length;
  if (outOfWindow > 0) {
    console.warn(
      `[agent/events] rig ${rigNumber}: stored ${outOfWindow} lap(s) unattributed - ` +
        `their completedAt falls outside the assignment they name. Either the rig ` +
        `PC's clock has drifted, or the rig was offline while the seat changed hands.`,
    );
  }
}

async function ingestLap(
  rigId: string,
  lap: LapCompletedEvent,
  combo: FeaturedCombo | null,
  attribution: Attribution,
): Promise<{ type: string; status: string; eventId: string }> {
  const base = { type: lap.type, eventId: lap.eventId };
  const assignment =
    attribution.kind === "attributed" ? attribution.assignment : null;

  // An unattributed lap is stored invalid with the UNATTRIBUTED reason, and the
  // database will not accept any other combination (laps_unattributed_is_invalid
  // in db/migrations/0003). Combo and incident checks are moot: no owner means
  // it cannot rank whatever it did on track.
  const validity = assignment
    ? computeValidity(lap, combo)
    : { isValid: false, invalidReason: "UNATTRIBUTED" as const };

  try {
    const inserted = await queryOne<{ id: string }>(
      `insert into laps (
         event_id, rig_id, rig_assignment_id, driver_id,
         track_name, track_config, car_name, lap_number, lap_time_ms,
         incident_delta, is_valid, invalid_reason, completed_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (event_id) do nothing
       returning id`,
      [
        lap.eventId,
        rigId,
        assignment?.id ?? null,
        assignment?.driver_id ?? null,
        lap.trackName,
        lap.trackConfig ?? null,
        lap.carName,
        lap.lapNumber ?? null,
        lap.lapTimeMs,
        lap.incidentDelta ?? null,
        validity.isValid,
        validity.invalidReason,
        lap.completedAt,
      ],
    );

    if (!inserted) return { ...base, status: "duplicate" };
    if (!assignment) return { ...base, status: "accepted_unattributed" };

    return { ...base, status: validity.isValid ? "accepted" : "accepted_invalid" };
  } catch (error) {
    console.error("[agent/events] lap insert failed", {
      rigId,
      eventId: lap.eventId,
      message: (error as Error).message,
    });
    return { ...base, status: "error" };
  }
}
