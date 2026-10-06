import { query } from "@/lib/db";
import { isOpenTonight } from "@/lib/league";
import { getOpenRound } from "@/lib/league-queries";
import { liveRace, RACE_DROP_AFTER_S, type RaceStatusRow } from "@/lib/race-live";

/**
 * The live race, public like the other feeds: every rig that has reported its
 * race status (POST /api/agent/race-status) in the last RACE_DROP_AFTER_S,
 * grouped into iRacing sessions, the largest group of rigs still reporting
 * returned as the race in race order (lib/race-live.ts owns those rules). On
 * league night - tonight's round open - a `Race` session is preferred to any
 * larger group, so rigs still in practice or qualifying elsewhere cannot keep
 * the race off the wall.
 *
 * Each rig is joined to v_rig_status for whoever is checked in on it right now,
 * the same assignment that owns the laps it posts; a rig with nobody checked
 * in, or with a driver who is not `active` (the leaderboards hide those too),
 * comes back with a null driver and its rig number, so the board can still
 * count it. Nothing here identifies an iRacing account.
 *
 * Freshness is judged by the database clock against `received_at`, never by a
 * rig's clock or this instance's, so every row's age is on one clock.
 */
export async function GET() {
  try {
    const reports = await query<RaceStatusRow>(
      `select v.rig_number, d.id as driver_id, d.display_name as driver_name,
              extract(epoch from now() - s.received_at)::float8 as age_s,
              s.session_unique_id, s.session_num, s.session_type, s.session_state,
              s.session_flags::float8 as session_flags,
              s.session_time_remain_s, s.session_laps_remain, s.car_idx,
              s.position, s.class_position, s.lap, s.laps_completed, s.lap_dist_pct,
              s.gap_to_leader_s, s.last_lap_ms, s.best_lap_ms, s.on_pit_road, s.incidents
       from rig_race_status s
       join v_rig_status v on v.rig_id = s.rig_id
       left join drivers d on d.id = v.driver_id and d.status = 'active'
       where s.received_at > now() - make_interval(secs => $1)`,
      [RACE_DROP_AFTER_S],
    );
    const openRound = await getOpenRound();
    const preferRace = openRound !== null && isOpenTonight(openRound);
    return Response.json(liveRace(reports, { preferRace }));
  } catch (error) {
    console.error("[race/live] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
