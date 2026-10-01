import { query } from "@/lib/db";
import { rigFromBearer } from "@/lib/agent-auth";
import { MAX_RACE_STATUS_BODY_BYTES, raceStatusEvent } from "@/lib/events";
import { parseJson, readBody } from "@/lib/http";

/**
 * One rig's live race status (`raceStatusEvent` in src/lib/events.ts, which
 * also says what the agent owes this route). Agent-authed and scoped to the
 * caller's own rig: the row replaced is always the token's rig, never one the
 * body names.
 *
 * Kept off /api/agent/events on purpose. That route is batched, idempotent and
 * fed from an outbox that holds a lap until it is stored; a race position is
 * the opposite - worth something for seconds, latest wins, dropped on failure -
 * and putting it in the outbox would queue stale positions behind laps.
 *
 * The upsert is one statement, and the row kept is whichever report ARRIVED
 * last, not the one the rig's clock calls newest. The agent sends one report
 * at a time, so arrival order is send order unless a timed-out request lands
 * late, and that shows an old position for one cadence. Ordering by
 * `sampled_at` instead would let a rig clock stepped backwards freeze the row
 * until the clock caught up, and a frozen row ages out of the feed: a car
 * racing for position would drop off the board.
 *
 * It does not touch `rigs.last_seen_at`: the heartbeat owns that, and a
 * second write per report, several a second across the venue, buys nothing.
 */
export async function POST(request: Request) {
  const rig = await rigFromBearer(request.headers.get("authorization"));
  if (!rig) return Response.json({ error: "unauthorized" }, { status: 401 });

  const raw = await readBody(request, MAX_RACE_STATUS_BODY_BYTES);
  if (raw === null) {
    return Response.json({ error: "body_too_large" }, { status: 413 });
  }
  const parsed = raceStatusEvent.safeParse(parseJson(raw));
  if (!parsed.success) {
    // The issues go back so a contract mismatch on a rig is readable from its
    // log; nothing on the agent acts on them.
    return Response.json(
      { error: "invalid_input", detail: parsed.error.issues },
      { status: 400 },
    );
  }

  const s = parsed.data;
  try {
    await query(
      `insert into rig_race_status (
         rig_id, received_at, sampled_at, session_unique_id, session_num, session_type,
         session_state, session_flags, session_time_remain_s, session_laps_remain,
         car_idx, position, class_position, lap, laps_completed, lap_dist_pct,
         gap_to_leader_s, last_lap_ms, best_lap_ms, on_pit_road, incidents)
       values ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               $15, $16, $17, $18, $19, $20)
       on conflict (rig_id) do update set
         received_at = excluded.received_at,
         sampled_at = excluded.sampled_at,
         session_unique_id = excluded.session_unique_id,
         session_num = excluded.session_num,
         session_type = excluded.session_type,
         session_state = excluded.session_state,
         session_flags = excluded.session_flags,
         session_time_remain_s = excluded.session_time_remain_s,
         session_laps_remain = excluded.session_laps_remain,
         car_idx = excluded.car_idx,
         position = excluded.position,
         class_position = excluded.class_position,
         lap = excluded.lap,
         laps_completed = excluded.laps_completed,
         lap_dist_pct = excluded.lap_dist_pct,
         gap_to_leader_s = excluded.gap_to_leader_s,
         last_lap_ms = excluded.last_lap_ms,
         best_lap_ms = excluded.best_lap_ms,
         on_pit_road = excluded.on_pit_road,
         incidents = excluded.incidents`,
      [
        rig.id,
        s.sampledAt,
        s.sessionUniqueId,
        s.sessionNum,
        s.sessionType,
        s.sessionState,
        s.sessionFlags,
        s.sessionTimeRemainS,
        s.sessionLapsRemain,
        s.carIdx,
        s.position,
        s.classPosition,
        s.lap,
        s.lapsCompleted,
        s.lapDistPct,
        s.gapToLeaderS,
        s.lastLapMs,
        s.bestLapMs,
        s.onPitRoad,
        s.incidents,
      ],
    );
    return new Response(null, { status: 200 });
  } catch (error) {
    // The agent drops a report that fails and sends the next sample; there is
    // nothing to retry.
    console.error("[agent/race-status] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
