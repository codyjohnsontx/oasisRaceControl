/**
 * The live race feed (`GET /api/race/live`) from the rigs' latest race reports:
 * which reports make up "the race", in what order, and what the board may say
 * about each car. Pure, so every rule is tested without a database; the route
 * only reads the rows and the database clock. docs/live-race.md describes the
 * loop end to end.
 */

import { SESSION_STATE } from "./events";

/** A rig silent this long is still in the race but shown as `stale`. */
export const RACE_STALE_AFTER_S = 15;
/** A rig silent this long is no longer in the feed at all. */
export const RACE_DROP_AFTER_S = 60;

/**
 * Whether iRacing's session type is a race, the one session where
 * `CarIdxF2Time` is a gap to the leader rather than a lap time. Exact, as
 * iRacing spells it in `SessionInfo.Sessions[].SessionType`.
 */
export function isRaceSession(sessionType: string | null): boolean {
  return sessionType === "Race";
}

/** One rig's latest report joined to its rig and signed-in driver, as the route reads it. */
export type RaceStatusRow = {
  rig_number: number;
  /** Null when nobody is checked in on the rig; the board names it by rig number. */
  driver_id: string | null;
  driver_name: string | null;
  /** Seconds since the report arrived, by the database clock. */
  age_s: number;
  session_unique_id: number;
  session_num: number;
  session_type: string | null;
  session_state: number;
  session_flags: number;
  session_time_remain_s: number | null;
  session_laps_remain: number | null;
  car_idx: number;
  position: number | null;
  class_position: number | null;
  lap: number | null;
  laps_completed: number | null;
  lap_dist_pct: number | null;
  gap_to_leader_s: number | null;
  last_lap_ms: number | null;
  best_lap_ms: number | null;
  on_pit_road: boolean;
  incidents: number;
};

export type LiveRaceSession = {
  sessionUniqueId: number;
  sessionNum: number;
  /**
   * The rest of this object is the leader's report: the first car still
   * reporting, in iRacing's position order.
   */
  sessionType: string | null;
  isRace: boolean;
  /**
   * Whether `rows` are the running order on track, which they are only in a
   * race under green (`SessionState` racing). On the grid, the parade lap and
   * after the chequered flag they follow iRacing's position instead.
   */
  byTrack: boolean;
  sessionState: number;
  sessionFlags: number;
  timeRemainS: number | null;
  lapsRemain: number | null;
};

export type LiveRaceRow = {
  rigNumber: number;
  driverId: string | null;
  driverName: string | null;
  carIdx: number;
  /**
   * This row's number on the board: its place in `rows`, from 1, never
   * repeated. Number the board by this, not by `position`. In a race under
   * green it is the running order on track, by how far round each car is, so a
   * pass shows at the next report from each car rather than when iRacing's
   * `position` catches up at the line. Otherwise it follows `position`, and two
   * neighbours that both report the same one are put in order by how far
   * round each is.
   */
  place: number;
  /** iRacing's own position, as the rig last reported it; it can trail `place`. */
  position: number | null;
  classPosition: number | null;
  lap: number | null;
  lapsCompleted: number | null;
  lapDistPct: number | null;
  /** Null outside a race, where iRacing's variable holds a lap time instead. */
  gapToLeaderS: number | null;
  /**
   * Seconds behind the row above - the car ahead on the board, which is the
   * car ahead on track while every car in the race has an agent. Null for the
   * leader, outside a race, and when either gap is unknown.
   */
  intervalS: number | null;
  lastLapMs: number | null;
  bestLapMs: number | null;
  onPitRoad: boolean;
  incidents: number;
  ageS: number;
  /** Silent for more than RACE_STALE_AFTER_S: show it dimmed. */
  stale: boolean;
};

export type LiveRace = {
  /** Null when no rig has reported in the last RACE_DROP_AFTER_S. */
  session: LiveRaceSession | null;
  rows: LiveRaceRow[];
  /** Rigs reporting from some other session, left out of `rows`. */
  otherRigs: number;
};

export type LiveRaceOptions = {
  /**
   * League night: a group whose session type is `Race` wins over any other,
   * whatever their sizes. The route sets it while tonight's round is open,
   * when the race is what the wall and the phone are for; on any other day
   * the sizes alone decide, as before.
   */
  preferRace?: boolean;
};

/**
 * Groups the reports by iRacing session and returns the largest group of rigs
 * still reporting as the race, in race order.
 *
 * A session is SessionUniqueID together with SessionNum: rigs in one hosted
 * race agree on both, and keying on the pair keeps a rig still in practice from
 * being counted into the race whatever SessionUniqueID turns out to mean on a
 * real server. A group is sized by the rigs still reporting - inside
 * RACE_STALE_AFTER_S - so a session that rigs have left does not hold the
 * board for the minute its rows take to drop (the whole field leaving
 * qualifying for the race is the ordinary case, and it must not hide the race
 * for a minute); only when no rig is live anywhere do the silent rows count.
 * Ties go to the group heard from most recently, then to the higher session
 * id, so the answer never depends on row order. The group is a race when any
 * of its rigs has read the session type as `Race`, and with `preferRace` such
 * a group wins outright.
 *
 * Expects only rows inside RACE_DROP_AFTER_S; the route filters by the
 * database clock.
 */
export function liveRace(
  reports: readonly RaceStatusRow[],
  options: LiveRaceOptions = {},
): LiveRace {
  const groups = new Map<string, RaceStatusRow[]>();
  for (const report of reports) {
    const key = `${report.session_unique_id}:${report.session_num}`;
    const group = groups.get(key);
    if (group) group.push(report);
    else groups.set(key, [report]);
  }

  const raceFirst = (group: readonly RaceStatusRow[]) =>
    options.preferRace && group.some((report) => isRaceSession(report.session_type)) ? 1 : 0;
  const race = [...groups.values()].sort(
    (a, b) =>
      raceFirst(b) - raceFirst(a) ||
      live(b) - live(a) ||
      b.length - a.length ||
      freshest(a) - freshest(b) ||
      b[0]!.session_unique_id - a[0]!.session_unique_id ||
      b[0]!.session_num - a[0]!.session_num,
  )[0];
  if (!race) return { session: null, rows: [], otherRigs: 0 };

  const isRace = race.some((report) => isRaceSession(report.session_type));
  const byPosition = [...race].sort(positionOrder);
  // The session's clock and state come from iRacing's leader among the cars
  // still reporting: a silent leader's report is a frozen clock.
  const leader = byPosition.find((report) => !isStale(report)) ?? byPosition[0]!;
  const byTrack = isRace && leader.session_state === SESSION_STATE.racing;
  const ordered = byTrack ? [...race].sort(trackOrder) : byPosition;

  const rows = ordered.map((report, i): LiveRaceRow => {
    const gap = isRace ? report.gap_to_leader_s : null;
    // No interval is measured to or from a silent car: its gap is as old as
    // its report, and the difference would be a number that never happened.
    const above = i > 0 ? ordered[i - 1]! : null;
    const ahead =
      isRace && above && !isStale(above) && !isStale(report) ? above.gap_to_leader_s : null;
    return {
      rigNumber: report.rig_number,
      driverId: report.driver_id,
      driverName: report.driver_name,
      carIdx: report.car_idx,
      place: i + 1,
      position: report.position,
      classPosition: report.class_position,
      lap: report.lap,
      lapsCompleted: report.laps_completed,
      lapDistPct: report.lap_dist_pct,
      gapToLeaderS: gap,
      // Two rigs sample at different instants, so their gaps can disagree by
      // a fraction of a second; a car ahead on the board is never shown behind.
      // Rounded to the millisecond iRacing's own times carry, so a difference
      // of two floats does not reach the board as 3.7279999999999998.
      intervalS:
        gap !== null && ahead !== null ? Math.round(Math.max(0, gap - ahead) * 1000) / 1000 : null,
      lastLapMs: report.last_lap_ms,
      bestLapMs: report.best_lap_ms,
      onPitRoad: report.on_pit_road,
      incidents: report.incidents,
      ageS: report.age_s,
      stale: isStale(report),
    };
  });

  return {
    session: {
      sessionUniqueId: leader.session_unique_id,
      sessionNum: leader.session_num,
      sessionType: leader.session_type,
      isRace,
      byTrack,
      sessionState: leader.session_state,
      sessionFlags: leader.session_flags,
      timeRemainS: leader.session_time_remain_s,
      lapsRemain: leader.session_laps_remain,
    },
    rows,
    otherRigs: reports.length - race.length,
  };
}

function isStale(report: RaceStatusRow): boolean {
  return report.age_s > RACE_STALE_AFTER_S;
}

function freshest(group: readonly RaceStatusRow[]): number {
  return Math.min(...group.map((report) => report.age_s));
}

/** Rigs in the group still reporting: those not yet stale. */
function live(group: readonly RaceStatusRow[]): number {
  return group.filter((report) => !isStale(report)).length;
}

/**
 * In a race under green, how far round each car is: laps completed, then
 * distance into the lap. iRacing's position only moves when a car crosses the
 * line, so ordering by it would hold a pass made mid-lap off the board for up
 * to a lap. Not before the green or after the flag: on the grid progress
 * depends on how the counters wrap at the line, and after the flag a winner
 * who slows or leaves the car falls behind cars still driving round. A silent
 * car stays where its last report put it on track, and any car still reporting
 * that gets further round goes ahead of it. iRacing's position only breaks a
 * tie, and the rig number settles anything left so the order is stable.
 */
function trackOrder(a: RaceStatusRow, b: RaceStatusRow): number {
  return progress(a, b) || reported(a, b) || a.rig_number - b.rig_number;
}

/**
 * Outside a race, where position ranks lap times rather than places on track,
 * and in a race that is not under green, iRacing's own position first. A silent car keeps the place it last
 * reported, but once another car reports that same place, the one reporting
 * is the one in it, and the silent car is shown after it. A car iRacing has
 * not classified yet goes after every classified one, by how far round it is.
 */
function positionOrder(a: RaceStatusRow, b: RaceStatusRow): number {
  return reported(a, b) || progress(a, b) || a.rig_number - b.rig_number;
}

function progress(a: RaceStatusRow, b: RaceStatusRow): number {
  return (
    nullsLast(a.laps_completed, b.laps_completed, (x, y) => y - x) ||
    nullsLast(a.lap_dist_pct, b.lap_dist_pct, (x, y) => y - x)
  );
}

function reported(a: RaceStatusRow, b: RaceStatusRow): number {
  return (
    nullsLast(a.position, b.position, (x, y) => x - y) ||
    Number(isStale(a)) - Number(isStale(b))
  );
}

function nullsLast(
  a: number | null,
  b: number | null,
  compare: (a: number, b: number) => number,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compare(a, b);
}
