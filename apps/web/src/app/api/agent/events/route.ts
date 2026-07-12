import { query, queryOne } from "@/lib/db";
import { rigFromBearer } from "@/lib/agent-auth";
import { agentEventsBody, type LapCompletedEvent } from "@/lib/events";
import { computeValidity, type FeaturedCombo } from "@/lib/validity";
import { venueToday } from "@/lib/venue";

/**
 * Idempotent agent event ingestion.
 *
 * PROVISIONAL CONTRACT: the event shape (src/lib/events.ts) may change when
 * the Phase 1 spike findings land (docs/spike-findings.md). The C# Rig Agent
 * must be built against the final version. The fake-rig simulator
 * (scripts/fake-rig.ts) is today's only client.
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
        results.push(await ingestLap(rig.id, event, combo));
      }
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

async function ingestLap(
  rigId: string,
  lap: LapCompletedEvent,
  combo: FeaturedCombo | null,
): Promise<{ type: string; status: string; eventId: string }> {
  const base = { type: lap.type, eventId: lap.eventId };

  // Laps attach to the rig's open assignment at ingestion time. If nobody is
  // checked in, the lap is rejected rather than guessed onto a past driver.
  const assignment = await queryOne<{ id: string; driver_id: string }>(
    "select id, driver_id from rig_assignments where rig_id = $1 and ended_at is null",
    [rigId],
  );
  if (!assignment) return { ...base, status: "no_active_assignment" };

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
