import { query, queryOne } from "@/lib/db";
import { rigFromBearer } from "@/lib/agent-auth";
import { agentEventsBody, type LapCompletedEvent } from "@/lib/events";
import { computeValidity, type FeaturedCombo } from "@/lib/validity";
import { venueToday } from "@/lib/venue";
import type { SimHealth } from "@/lib/rig-health";

/**
 * Idempotent agent event ingestion.
 *
 * PROVISIONAL CONTRACT: the event shape (src/lib/events.ts) may change when
 * the Phase 1 spike findings land (docs/spike-findings.md). Clients are the C#
 * Rig Agent (apps/rig-agent) and the fake-rig simulator (scripts/fake-rig.ts),
 * so a field the agent already sends cannot be renamed without shipping both.
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
        await recordHeartbeat(rig.id, event);
        results.push({ type: event.type, status: "ok" });
      } else if (rig.installation_conflict) {
        // Two computers are heartbeating with this rig's token, so there is no
        // honest answer to "whose lap is this" - the assignment it would be
        // attributed to belongs to whoever is checked in on the rig, and that is
        // a coin toss between two customers. Refusing with a status the agent
        // does not treat as settled keeps the lap in that machine's own outbox:
        // nothing is lost, and every held lap delivers itself the moment
        // somebody gives the second machine its own token.
        results.push({ type: event.type, status: "rig_conflict", eventId: event.eventId });
      } else {
        results.push(await ingestLap(rig.id, event, combo));
      }
    }

    if (results.some((r) => r.status === "rig_conflict")) {
      console.error("[agent/events] holding laps: two computers share this rig's token", {
        rigNumber: rig.rig_number,
        machines: rig.installation_conflict_detail,
      });
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

/**
 * One heartbeat's worth of what the backend knows about a rig's agent.
 *
 * Three different lifetimes sit in this one statement, deliberately:
 *
 * - `agent_version` is a fact about the install, so it survives a heartbeat
 *   that omits it.
 * - `sim_health` is a LIVE READING, so it is replaced outright: an agent that
 *   stops reporting it makes the answer unknown, and leaving the last verdict up
 *   would show a stale "cannot score" (or worse, a stale "scoring") next to a
 *   rig nobody has heard from about it.
 * - the installation is a CLAIM on the rig, and claims can be contested.
 *
 * The claim is settled inside the statement rather than by a read then a write,
 * so two agents heartbeating at the same instant cannot both decide they own the
 * rig. `owns` is true when nothing is contesting it: no installation recorded,
 * the same one as last time, or a recorded one that has gone quiet for longer
 * than the fleet's liveness window - a rig PC replaced or re-imaged is ordinary
 * venue maintenance and must not need a database edit. `conflicts` is the
 * opposite case, a different installation while the recorded one is still live,
 * which is exactly two machines sharing one rig's token.
 *
 * The conflict is stamped rather than cleared. Once the second machine is given
 * its own token it stops heartbeating here and the stamp ages past
 * rig_installation_live() on its own, so nothing has to notice that it stopped.
 *
 * An agent too old to send an installation leaves all of it alone, or a fleet
 * part-way through an update would flap between claimed and unknown.
 */
async function recordHeartbeat(
  rigId: string,
  event: {
    agentVersion?: string | null;
    simHealth?: SimHealth | null;
    simHealthDetail?: string | null;
    installationId?: string | null;
    machineName?: string | null;
  },
): Promise<void> {
  await query(
    `with claim as (
       select
         $5::text as new_id,
         $6::text as new_name,
         r.agent_machine_name as old_name,
         ($5::text is not null and (
            r.agent_installation_id is null
            or r.agent_installation_id = $5::text
            or not rig_installation_live(r.agent_installation_seen_at))) as owns,
         ($5::text is not null
            and r.agent_installation_id is not null
            and r.agent_installation_id <> $5::text
            and rig_installation_live(r.agent_installation_seen_at)) as conflicts
       from rigs r where r.id = $1
     )
     update rigs set
       last_seen_at = now(),
       agent_version = coalesce($2, agent_version),
       sim_health = $3::rig_sim_health,
       sim_health_detail = $4,
       agent_installation_id =
         case when claim.owns then claim.new_id else rigs.agent_installation_id end,
       agent_machine_name =
         case when claim.owns then claim.new_name else rigs.agent_machine_name end,
       agent_installation_seen_at =
         case when claim.owns then now() else rigs.agent_installation_seen_at end,
       installation_conflict_at =
         case when claim.conflicts then now() else rigs.installation_conflict_at end,
       installation_conflict_detail =
         case when claim.conflicts
           -- Two machines reporting the SAME name is reachable (a cloned image
           -- nobody renamed), and "RIG-03 and RIG-03" reads like a bug in the
           -- dashboard rather than the thing to go and look at.
           then case when coalesce(claim.old_name, '') = coalesce(claim.new_name, '')
             then 'two computers both calling themselves '
                  || coalesce(claim.new_name, 'nothing')
             else coalesce(claim.old_name, 'an unnamed computer')
                  || ' and ' || coalesce(claim.new_name, 'an unnamed computer') end
           else rigs.installation_conflict_detail end
     from claim
     where rigs.id = $1`,
    [
      rigId,
      event.agentVersion ?? null,
      event.simHealth ?? null,
      // Only the unreadable verdict has anything to explain; carrying a detail
      // on the others would leave "does not publish LapCompleted" sitting beside
      // a rig that is scoring fine.
      event.simHealth === "unreadable" ? (event.simHealthDetail ?? null) : null,
      event.installationId ?? null,
      event.machineName ?? null,
    ],
  );
}

/**
 * Slack on both edges of the assignment window. A lap's completion time is
 * stamped by the rig's clock and the assignment's by the database's, so the two
 * are never exactly comparable and a rig running a few seconds fast would
 * otherwise drop honest laps. A lap takes minutes, so seconds of slack cannot
 * reopen the misattribution this guard exists to stop - a lap driven before the
 * current customer ever checked in.
 */
const WINDOW_GRACE = "5 seconds";

/**
 * Finds the assignment a lap belongs to, or null when no assignment can own it.
 *
 * A lap is only ever attributed to an assignment whose window contains the
 * lap's own completion time. That single rule covers the ways a rig's outbox
 * and the venue's check-in desk drift apart:
 *
 * - The agent flushes after an outage and the rig has changed hands. The lap
 *   carries the assignment it was driven under, so it stays with its real
 *   driver even though that assignment is now closed - it is never reassigned
 *   to whoever is checked in at delivery time.
 * - The agent's view is stale the other way: it stamps an assignment that was
 *   already closed (staff cleared the rig, idle timeout) before the lap was
 *   actually driven. The completion time falls outside the window, so the lap
 *   is refused rather than credited to a driver who had already left.
 * - The driver checked in seconds before crossing the line and the agent had
 *   not polled yet, so the lap carries no assignment at all. The rig's open
 *   assignment started before the lap finished, so it is accepted.
 * - A lap driven with nobody checked in, delivered after the next customer
 *   checks in. The open assignment started after the lap finished, so it is
 *   refused rather than credited to the new customer.
 *
 * Both branches are the same predicate, so a lap outside every window is
 * refused rather than credited to the wrong driver.
 */
async function resolveAssignment(
  rigId: string,
  lap: LapCompletedEvent,
): Promise<{ id: string; driver_id: string } | null> {
  if (lap.rigAssignmentId) {
    return queryOne<{ id: string; driver_id: string }>(
      `select id, driver_id from rig_assignments
       where id = $1 and rig_id = $2
         and started_at - $4::interval <= $3::timestamptz
         and (ended_at is null or $3::timestamptz <= ended_at + $4::interval)`,
      [lap.rigAssignmentId, rigId, lap.completedAt, WINDOW_GRACE],
    );
  }

  return queryOne<{ id: string; driver_id: string }>(
    `select id, driver_id from rig_assignments
     where rig_id = $1 and ended_at is null
       and started_at - $3::interval <= $2::timestamptz`,
    [rigId, lap.completedAt, WINDOW_GRACE],
  );
}

/**
 * What a lap whose event id is already stored actually is.
 *
 * Almost always a retry: the rig delivered it, lost the answer, and sent it
 * again. That lap is already on the board and there is nothing to do.
 *
 * The other possibility is that two different laps were minted with one id, and
 * that one is not recoverable - `on conflict do nothing` means the second lap is
 * gone, and it looks exactly like a retry from every screen the venue has. That
 * is how a customer can drive a clean night and not be on the leaderboard, with
 * the rig green and nothing logged anywhere. The agent stopped producing
 * colliding ids (`LapDetector`, the run token), so this is the check that says so
 * if it ever starts again.
 *
 * The answer on the wire stays `duplicate` either way. A new status would be
 * unknown to any rig not yet updated, which would leave those rigs retrying the
 * lap until closing time and holding every lap behind it.
 */
async function describeDuplicate(rigId: string, lap: LapCompletedEvent): Promise<string> {
  const stored = await queryOne<{
    track_name: string;
    track_config: string | null;
    car_name: string;
    lap_time_ms: number;
    completed_at: Date | string;
    driver_id: string;
  }>(
    `select track_name, track_config, car_name, lap_time_ms, completed_at, driver_id
     from laps where event_id = $1`,
    [lap.eventId],
  );

  // Gone between the insert and this read (a staff deletion, a race) - nothing
  // useful can be said, and "duplicate" is still the honest answer.
  if (!stored) return "duplicate";

  const sameLap =
    stored.track_name === lap.trackName &&
    (stored.track_config ?? "") === (lap.trackConfig ?? "") &&
    stored.car_name === lap.carName &&
    stored.lap_time_ms === lap.lapTimeMs &&
    new Date(stored.completed_at).getTime() === new Date(lap.completedAt).getTime();

  if (!sameLap) {
    console.error("[agent/events] LAP LOST - two different laps carry one event id", {
      rigId,
      eventId: lap.eventId,
      stored: {
        driverId: stored.driver_id,
        track: stored.track_name,
        config: stored.track_config,
        car: stored.car_name,
        lapTimeMs: stored.lap_time_ms,
        completedAt: new Date(stored.completed_at).toISOString(),
      },
      arrived: {
        track: lap.trackName,
        config: lap.trackConfig ?? null,
        car: lap.carName,
        lapTimeMs: lap.lapTimeMs,
        completedAt: lap.completedAt,
      },
    });
  }

  return "duplicate";
}

async function ingestLap(
  rigId: string,
  lap: LapCompletedEvent,
  combo: FeaturedCombo | null,
): Promise<{ type: string; status: string; eventId: string }> {
  const base = { type: lap.type, eventId: lap.eventId };

  const assignment = await resolveAssignment(rigId, lap);
  if (!assignment) {
    // Two different operational stories, so they get two different answers:
    // nobody was checked in to own this lap, versus the rig named a driver and
    // that claim does not hold. Both are final - see resolveAssignment.
    return {
      ...base,
      status: lap.rigAssignmentId ? "assignment_mismatch" : "no_active_assignment",
    };
  }

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

    if (!inserted) return { ...base, status: await describeDuplicate(rigId, lap) };

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
