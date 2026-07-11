import { serviceClient } from "@/lib/supabase";
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
  const db = serviceClient();
  const rig = await rigFromBearer(db, request.headers.get("authorization"));
  if (!rig) return Response.json({ error: "unauthorized" }, { status: 401 });

  const parsed = agentEventsBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_input", detail: parsed.error.issues },
      { status: 400 },
    );
  }

  // Tonight's combo applies to the whole batch — look it up once, not per lap.
  let combo: FeaturedCombo | null = null;
  if (parsed.data.events.some((event) => event.type === "LAP_COMPLETED")) {
    const { data } = await db
      .from("featured_combos")
      .select("track_name, track_config, car_name, incident_limit")
      .eq("combo_date", venueToday())
      .maybeSingle<FeaturedCombo>();
    combo = data ?? null;
  }

  const results: Array<{ type: string; status: string; eventId?: string }> = [];

  for (const event of parsed.data.events) {
    if (event.type === "RIG_HEARTBEAT") {
      await db
        .from("rigs")
        .update({
          last_seen_at: new Date().toISOString(),
          ...(event.agentVersion ? { agent_version: event.agentVersion } : {}),
        })
        .eq("id", rig.id);
      results.push({ type: event.type, status: "ok" });
    } else {
      results.push(await ingestLap(db, rig.id, event, combo));
    }
  }

  // Any activity proves the agent is alive.
  await db.from("rigs").update({ last_seen_at: new Date().toISOString() }).eq("id", rig.id);

  return Response.json({ results });
}

async function ingestLap(
  db: ReturnType<typeof serviceClient>,
  rigId: string,
  lap: LapCompletedEvent,
  combo: FeaturedCombo | null,
): Promise<{ type: string; status: string; eventId: string }> {
  const base = { type: lap.type, eventId: lap.eventId };

  // Laps attach to the rig's open assignment at ingestion time. If nobody is
  // checked in, the lap is rejected rather than guessed onto a past driver.
  const { data: assignment } = await db
    .from("rig_assignments")
    .select("id, driver_id")
    .eq("rig_id", rigId)
    .is("ended_at", null)
    .maybeSingle();
  if (!assignment) return { ...base, status: "no_active_assignment" };

  const validity = computeValidity(lap, combo);

  const { data: inserted, error } = await db
    .from("laps")
    .upsert(
      {
        event_id: lap.eventId,
        rig_id: rigId,
        rig_assignment_id: assignment.id,
        driver_id: assignment.driver_id,
        track_name: lap.trackName,
        track_config: lap.trackConfig ?? null,
        car_name: lap.carName,
        lap_number: lap.lapNumber ?? null,
        lap_time_ms: lap.lapTimeMs,
        incident_delta: lap.incidentDelta ?? null,
        is_valid: validity.isValid,
        invalid_reason: validity.invalidReason,
        completed_at: lap.completedAt,
      },
      { onConflict: "event_id", ignoreDuplicates: true },
    )
    .select("id");

  if (error) {
    console.error("[agent/events] lap upsert failed", {
      rigId,
      eventId: lap.eventId,
      code: error.code,
      message: error.message,
    });
    return { ...base, status: "error" };
  }
  if (!inserted || inserted.length === 0) return { ...base, status: "duplicate" };
  return { ...base, status: validity.isValid ? "accepted" : "accepted_invalid" };
}
