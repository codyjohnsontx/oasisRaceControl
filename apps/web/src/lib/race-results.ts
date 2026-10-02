import type { PoolClient } from "pg";
import { query, queryOne, withTransaction } from "./db";
import { SESSION_STATE, type RaceStatusEvent } from "./events";
import type { RaceReview, RaceReviewEntry } from "./league";
import { isRaceSession } from "./race-live";

/**
 * League night's race result: the only writer of league_race_results and
 * league_race_starts (db/migrations/0009_race_results.sql). Which race is the
 * round's, and which rows count, is the views' rule, v_league_race_session
 * and v_league_race_results; how a result turns into points is
 * league-scoring.ts.
 *
 * Three writers, one per moment of the night:
 *   - every race report a rig sends (POST /api/agent/race-status) while a
 *     round is open records that the rig was heard in its race session, and
 *     the first one from the round's race showing the chequered flag or
 *     cool-down records the rig's driver at iRacing's own place. That place is
 *     final: a later report, or an older one the live feed accepts late, never
 *     moves it - only staff do;
 *   - closing the round sweeps once more for any car of the round's race
 *     still missing, at its last reported place;
 *   - staff save the order they reviewed on /staff, which replaces every row of
 *     the round and freezes it against the other two.
 *
 * A captured row names its driver by the assignment the route stored with the
 * report (rig_race_status.rig_assignment_id) - whoever was in the seat when it
 * arrived, the rule laps use - never by whoever is in the seat when the row is
 * written. A rig whose race place is already recorded records nothing more for
 * that race, so a driver signing in during cool-down does not inherit it.
 *
 * A flag capture takes a share lock on the open round, and saving and closing
 * lock it exclusively before anything else, so each of them waits for a
 * capture in flight and a capture behind them reads what they committed.
 */

/** What one race report means for the round's result. */
export function raceReportCapture(
  report: Pick<RaceStatusEvent, "sessionType" | "sessionState" | "position">,
): { start: boolean; finish: boolean } {
  const start = isRaceSession(report.sessionType);
  const flagged =
    report.sessionState === SESSION_STATE.checkered ||
    report.sessionState === SESSION_STATE.coolDown;
  return { start, finish: start && flagged && report.position !== null };
}

/**
 * Records what a stored race report says about tonight's round, if one is
 * open. `assignmentId` is the rig's open assignment the route stored with the
 * report, null when nobody was checked in - then there is no driver to place.
 */
export async function captureRaceReport(
  rigId: string,
  assignmentId: string | null,
  report: Pick<
    RaceStatusEvent,
    "sessionUniqueId" | "sessionNum" | "sessionType" | "sessionState" | "position" | "lapsCompleted"
  >,
): Promise<void> {
  const capture = raceReportCapture(report);
  if (!capture.start) return;

  await query(
    `insert into league_race_starts (round_id, session_unique_id, session_num, rig_id)
     select id, $1, $2, $3 from league_rounds where closed_at is null
     on conflict do nothing`,
    [report.sessionUniqueId, report.sessionNum, rigId],
  );
  if (!capture.finish || assignmentId === null) return;

  await withTransaction(async (client) => {
    // Its own statement: the insert below must read with a snapshot taken
    // after any staff save or close this lock waited behind.
    const open = await client.query<{ id: string }>(
      "select id from league_rounds where closed_at is null for share",
    );
    const round = open.rows[0];
    if (!round) return;

    await client.query(
      `insert into league_race_results
         (round_id, driver_id, finish_position, source, rig_id,
          session_unique_id, session_num, laps_completed)
       select $1, ra.driver_id, $3, 'flag', $2, $4, $5, $6
       from rig_assignments ra
       where ra.id = $7
         and exists (select 1 from v_league_race_session v
                     where v.round_id = $1
                       and v.session_unique_id = $4 and v.session_num = $5)
         and not exists (select 1 from league_race_results x
                         where x.round_id = $1 and x.source = 'staff')
         and not exists (select 1 from league_race_results x
                         where x.round_id = $1 and x.rig_id = $2
                           and x.session_unique_id = $4 and x.session_num = $5)
       -- A row already held from this race is final. One from another session
       -- no longer counts (it stopped being the round's race), so this race
       -- replaces it.
       on conflict (round_id, driver_id) do update set
         finish_position = excluded.finish_position,
         source = excluded.source,
         rig_id = excluded.rig_id,
         session_unique_id = excluded.session_unique_id,
         session_num = excluded.session_num,
         laps_completed = excluded.laps_completed,
         recorded_at = now()
       where league_race_results.source = 'flag'
         and (league_race_results.session_unique_id, league_race_results.session_num)
             is distinct from (excluded.session_unique_id, excluded.session_num)`,
      [
        round.id,
        rigId,
        report.position,
        report.sessionUniqueId,
        report.sessionNum,
        report.lapsCompleted,
        assignmentId,
      ],
    );
  });
}

/**
 * The close-time sweep, on closeLeagueRound's transaction after it has locked
 * and closed the round: every car still reporting from the round's race
 * (v_league_race_session) that the flag capture never recorded, at the place
 * it last reported - a car that stopped before the flag, or every car when the
 * round closes mid-race - for the driver that report was stored for, not
 * whoever is in the seat at close. Nothing when staff saved a result or the
 * round has no race. Returns the rows recorded.
 */
export async function sweepRaceResultsTx(client: PoolClient, roundId: string): Promise<number> {
  const swept = await client.query(
    `insert into league_race_results
       (round_id, driver_id, finish_position, source, rig_id,
        session_unique_id, session_num, laps_completed)
     select $1, ra.driver_id, s.position, 'close', s.rig_id,
            s.session_unique_id, s.session_num, s.laps_completed
     from rig_race_status s
     join v_league_race_session t on t.round_id = $1
                                 and t.session_unique_id = s.session_unique_id
                                 and t.session_num = s.session_num
     join league_rounds r on r.id = $1
     join rig_assignments ra on ra.id = s.rig_assignment_id
     where s.position is not null
       and s.received_at >= r.opened_at
       and not exists (select 1 from league_race_results x
                       where x.round_id = $1 and x.source = 'staff')
       and not exists (select 1 from league_race_results x
                       where x.round_id = $1 and x.rig_id = s.rig_id
                         and x.session_unique_id = s.session_unique_id
                         and x.session_num = s.session_num)
     -- As at the flag: a row from this race stands, one from another session
     -- no longer counts and is replaced.
     on conflict (round_id, driver_id) do update set
       finish_position = excluded.finish_position,
       source = excluded.source,
       rig_id = excluded.rig_id,
       session_unique_id = excluded.session_unique_id,
       session_num = excluded.session_num,
       laps_completed = excluded.laps_completed,
       recorded_at = now()
     where (league_race_results.session_unique_id, league_race_results.session_num)
           is distinct from (excluded.session_unique_id, excluded.session_num)`,
    [roundId],
  );
  return swept.rowCount ?? 0;
}

/**
 * What staff review on /staff for an open round: the race result as it stands,
 * in the order the round will be placed by, and every driver in the field the
 * result does not mention, so a car that stopped reporting cannot vanish
 * without staff seeing it.
 */
export async function getRaceReview(roundId: string): Promise<RaceReview> {
  // One statement, so one snapshot: read in separate statements, a flag capture
  // committing between them can leave a driver in neither list - and a staff
  // save of that review deletes the place that driver was just given.
  const review = await queryOne<{
    race_heard: boolean;
    entries: RaceReviewEntry[];
    not_in_race: RaceReview["notInRace"];
  }>(
    `with entries as (
       select rr.driver_id, d.display_name::text as display_name, rr.finish_position,
              rr.source, rg.rig_number, rr.laps_completed
       from v_league_race_results rr
       join drivers d on d.id = rr.driver_id and d.status = 'active'
       left join rigs rg on rg.id = rr.rig_id
       where rr.round_id = $1
     ),
     not_in_race as (
       select distinct rl.driver_id, d.display_name::text as display_name
       from v_league_round_laps rl
       join drivers d on d.id = rl.driver_id and d.status = 'active'
       where rl.round_id = $1
         and not exists (select 1 from v_league_race_results rr
                         where rr.round_id = $1 and rr.driver_id = rl.driver_id)
     )
     select
       exists (select 1 from v_league_race_session where round_id = $1) as race_heard,
       coalesce((select json_agg(e order by e.finish_position is null, e.source = 'close',
                                            e.finish_position, e.laps_completed desc nulls last,
                                            e.display_name)
                 from entries e), '[]') as entries,
       coalesce((select json_agg(n order by n.display_name) from not_in_race n), '[]')
         as not_in_race`,
    [roundId],
  );
  const entries = review?.entries ?? [];
  return {
    raceHeard: review?.race_heard ?? false,
    confirmed: entries.length > 0 && entries.every((entry) => entry.source === "staff"),
    entries,
    notInRace: review?.not_in_race ?? [],
  };
}

/**
 * Staff's reviewed result for an open round: `finishers` in finishing order,
 * placed 1..n, and `dnf` in the race but not classified. Replaces every row of
 * the round, keeping where each captured place came from, and freezes the
 * round against capture. Only drivers already in the round - a lap in it or a
 * place in its race - can be named.
 */
export async function saveRaceResult(
  roundId: string,
  finishers: string[],
  dnf: string[],
): Promise<{ status: "saved" } | { status: "not_open" } | { status: "unknown_driver" }> {
  return withTransaction(async (client) => {
    const round = await client.query(
      "select id from league_rounds where id = $1 and closed_at is null for update",
      [roundId],
    );
    if (!round.rows[0]) return { status: "not_open" as const };

    const named = [...finishers, ...dnf];
    const known = await client.query<{ driver_id: string }>(
      `select f.driver_id
       from (select driver_id from v_league_round_laps where round_id = $1
             union
             select driver_id from league_race_results where round_id = $1) f
       join drivers d on d.id = f.driver_id and d.status = 'active'
       where f.driver_id = any ($2::uuid[])`,
      [roundId, named],
    );
    if (known.rows.length !== named.length) return { status: "unknown_driver" as const };

    await client.query(
      "delete from league_race_results where round_id = $1 and driver_id <> all ($2::uuid[])",
      [roundId, named],
    );
    await client.query(
      `insert into league_race_results (round_id, driver_id, finish_position, source)
       select $1, entry.driver_id, entry.place, 'staff'
       from unnest($2::uuid[], $3::int[]) as entry (driver_id, place)
       on conflict (round_id, driver_id) do update set
         finish_position = excluded.finish_position,
         source = excluded.source,
         recorded_at = now()`,
      [roundId, named, [...finishers.map((_, i) => i + 1), ...dnf.map(() => null)]],
    );
    return { status: "saved" as const };
  });
}
