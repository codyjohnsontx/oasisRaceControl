import type { PoolClient } from "pg";
import { query, queryOne, withTransaction } from "./db";
import { SESSION_STATE, type RaceStatusEvent } from "./events";
import type { RaceReview, RaceReviewEntry } from "./league";
import { isRaceSession } from "./race-live";

/**
 * League night's race result: the only writer of league_race_results and
 * league_race_starts (db/migrations/0009_race_results.sql). Which of the rows
 * are the round's race is the views' rule, v_league_race_session and
 * v_league_race_results; how a result turns into points is
 * league-scoring.ts.
 *
 * Three writers, one per moment of the night:
 *   - every race report a rig sends (POST /api/agent/race-status) while a
 *     round is open records when its race session was first heard, and while
 *     that race shows the chequered flag or cool-down records the rig's
 *     driver at iRacing's own place - refreshed on every report, so a car
 *     still crossing the line settles where iRacing puts it;
 *   - closing the round sweeps once more for any car of the race still
 *     missing, at its last reported place;
 *   - staff save the order they reviewed on /staff, which replaces every row of
 *     the round and freezes it against the other two.
 *
 * A captured row names its driver by the rig's open assignment when the report
 * arrives - whoever is in the seat, the rule laps use. A rig whose race place
 * is already held by one driver never records another for the same race, so a
 * driver signing in during cool-down does not inherit the place.
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
 * open. Called only for a report the race-status route actually stored, so a
 * late sample never rewinds a recorded place.
 */
export async function captureRaceReport(
  rigId: string,
  report: Pick<
    RaceStatusEvent,
    "sessionUniqueId" | "sessionNum" | "sessionType" | "sessionState" | "position" | "lapsCompleted"
  >,
): Promise<void> {
  const capture = raceReportCapture(report);
  if (!capture.start) return;

  await query(
    `insert into league_race_starts (round_id, session_unique_id, session_num)
     select id, $1, $2 from league_rounds where closed_at is null
     on conflict do nothing`,
    [report.sessionUniqueId, report.sessionNum],
  );
  if (!capture.finish) return;

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
       where ra.rig_id = $2 and ra.ended_at is null
         and not exists (select 1 from league_race_results x
                         where x.round_id = $1 and x.source = 'staff')
         and not exists (select 1 from league_race_results x
                         where x.round_id = $1 and x.rig_id = $2
                           and x.session_unique_id = $4 and x.session_num = $5
                           and x.driver_id <> ra.driver_id)
       on conflict (round_id, driver_id) do update set
         finish_position = excluded.finish_position,
         source = excluded.source,
         rig_id = excluded.rig_id,
         session_unique_id = excluded.session_unique_id,
         session_num = excluded.session_num,
         laps_completed = excluded.laps_completed,
         recorded_at = now()
       where league_race_results.source = 'flag'`,
      [
        round.id,
        rigId,
        report.position,
        report.sessionUniqueId,
        report.sessionNum,
        report.lapsCompleted,
      ],
    );
  });
}

/**
 * The close-time sweep, on closeLeagueRound's transaction after it has locked
 * and closed the round: every car still reporting from the round's race that
 * the flag capture never recorded, at the place it last reported - a car that
 * stopped before the flag, or every car when the round closes mid-race. The
 * race is the one the result already names, else whichever race heard while
 * the round was open has the most rigs reporting from it now. Nothing when
 * staff saved a result or no race was heard. Returns the rows recorded.
 */
export async function sweepRaceResultsTx(client: PoolClient, roundId: string): Promise<number> {
  const swept = await client.query(
    `with target as (
       select session_unique_id, session_num
       from (
         select session_unique_id, session_num, 0 as priority, 0::bigint as cars,
                null::timestamptz as started_at
         from v_league_race_session where round_id = $1
         union all
         select st.session_unique_id, st.session_num, 1,
                (select count(*) from rig_race_status s
                 where s.session_unique_id = st.session_unique_id
                   and s.session_num = st.session_num),
                st.started_at
         from league_race_starts st where st.round_id = $1
       ) candidates
       order by priority, cars desc, started_at desc
       limit 1
     )
     insert into league_race_results
       (round_id, driver_id, finish_position, source, rig_id,
        session_unique_id, session_num, laps_completed)
     select $1, ra.driver_id, s.position, 'close', s.rig_id,
            s.session_unique_id, s.session_num, s.laps_completed
     from rig_race_status s
     join target t on t.session_unique_id = s.session_unique_id
                  and t.session_num = s.session_num
     join league_rounds r on r.id = $1
     join rig_assignments ra on ra.rig_id = s.rig_id and ra.ended_at is null
     where s.position is not null
       and s.received_at >= r.opened_at
       and not exists (select 1 from league_race_results x
                       where x.round_id = $1 and x.source = 'staff')
       and not exists (select 1 from league_race_results x
                       where x.round_id = $1 and x.rig_id = s.rig_id
                         and x.session_unique_id = s.session_unique_id
                         and x.session_num = s.session_num)
     on conflict (round_id, driver_id) do nothing`,
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
  const [entries, notInRace, state] = await Promise.all([
    query<RaceReviewEntry>(
      `select rr.driver_id, d.display_name::text as display_name, rr.finish_position,
              rr.source, rg.rig_number, rr.laps_completed
       from v_league_race_results rr
       join drivers d on d.id = rr.driver_id and d.status = 'active'
       left join rigs rg on rg.id = rr.rig_id
       where rr.round_id = $1
       order by rr.finish_position is null, rr.source = 'close', rr.finish_position,
                rr.laps_completed desc nulls last, d.display_name`,
      [roundId],
    ),
    query<{ driver_id: string; display_name: string }>(
      `select distinct rl.driver_id, d.display_name::text as display_name
       from v_league_round_laps rl
       join drivers d on d.id = rl.driver_id and d.status = 'active'
       where rl.round_id = $1
         and not exists (select 1 from v_league_race_results rr
                         where rr.round_id = $1 and rr.driver_id = rl.driver_id)
       order by display_name`,
      [roundId],
    ),
    queryOne<{ race_heard: boolean }>(
      "select exists (select 1 from league_race_starts where round_id = $1) as race_heard",
      [roundId],
    ),
  ]);
  return {
    raceHeard: state?.race_heard ?? false,
    confirmed: entries.length > 0 && entries.every((entry) => entry.source === "staff"),
    entries,
    notInRace,
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
