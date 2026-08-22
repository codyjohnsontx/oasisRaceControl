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
 * can arrive long after its driver has left.
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
    const assignments = await loadStampedAssignments(rig.id, parsed.data.events);

    const results: Array<{ type: string; status: string; eventId?: string }> = [];

    for (const event of parsed.data.events) {
      if (event.type === "RIG_HEARTBEAT") {
        await query(
          `update rigs set last_seen_at = now(),
             agent_version = coalesce($2, agent_version)
           where id = $1`,
          [rig.id, event.agentVersion ?? null],
        );
        results.push({ type: event.type, status: "ok" });
      } else {
        results.push(await ingestLap(rig.id, event, combo, assignments));
      }
    }

    // An agent that cannot stamp its laps is stuck: nothing it drives will ever
    // be stored. Say so once per batch, so a rig left on an old build shows up
    // in the logs instead of just going quiet on the leaderboard.
    const unstamped = results.filter((r) => r.status === "attribution_unsupported").length;
    if (unstamped > 0) {
      console.warn(
        `[agent/events] rig ${rig.rig_number}: refused ${unstamped} lap(s) from an ` +
          `agent that sends no rigAssignmentId - update the rig agent`,
      );
    }

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

/**
 * Resolves every assignment id the batch stamped onto a lap, in one query,
 * scoped to the calling rig - the same "look it up once, not per lap" shape as
 * tonight's combo. An id belonging to another rig simply does not come back, so
 * the rig-scoping rule lives here and nowhere else.
 *
 * Open or closed is deliberately not part of the lookup. A lap that sat in the
 * outbox through a network outage still belongs to the driver who drove it, and
 * their assignment has usually closed by the time it lands; refusing it there
 * would throw away the backlog the durable outbox exists to protect.
 */
async function loadStampedAssignments(
  rigId: string,
  events: AgentEventsBody["events"],
): Promise<Map<string, StampedAssignment>> {
  const ids = [
    ...new Set(
      events.flatMap((event) =>
        event.type === "LAP_COMPLETED" && event.rigAssignmentId
          ? [event.rigAssignmentId]
          : [],
      ),
    ),
  ];
  if (ids.length === 0) return new Map();

  const rows = await query<StampedAssignment>(
    `select id, driver_id from rig_assignments
     where rig_id = $1 and id = any ($2::uuid[])`,
    [rigId, ids],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

async function ingestLap(
  rigId: string,
  lap: LapCompletedEvent,
  combo: FeaturedCombo | null,
  assignments: Map<string, StampedAssignment>,
): Promise<{ type: string; status: string; eventId: string }> {
  const base = { type: lap.type, eventId: lap.eventId };

  // Attribution is whatever the agent knew when it captured the lap, never
  // whatever is open now. Reading the rig's current assignment here is the
  // defect this replaces: a lap driven at 18:40 with nobody checked in was
  // credited to whoever checked in at 18:41.
  if (!statesCaptureTimeAttribution(lap)) {
    // An agent too old to stamp the lap. It cannot be attributed and must not
    // be guessed at, so it is refused - loudly enough to name the cause.
    return { ...base, status: "attribution_unsupported" };
  }
  if (lap.rigAssignmentId == null) {
    // Genuinely nobody in the seat when this was driven. Refused, and the agent
    // leaves it in its outbox; see docs/plan.md on unattributable laps.
    return { ...base, status: "no_active_assignment" };
  }

  const assignment = assignments.get(lap.rigAssignmentId);
  // Unknown to this rig: a stale outbox from a rebuilt database, or one rig's
  // token quoting another rig's assignment. Never falls back to a live lookup.
  if (!assignment) return { ...base, status: "unknown_assignment" };

  const validity = computeValidity(lap, combo);

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
        assignment.id,
        assignment.driver_id,
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
