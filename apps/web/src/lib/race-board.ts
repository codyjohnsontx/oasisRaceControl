/**
 * What a live race screen shows, decided once for the wall's league board and
 * the `/league` page: when the race order replaces the standings, how long the
 * finishing order stays up after the flag, which rows just changed place, and
 * the words for a session's state and what is left of it.
 *
 * Pure, over the public feed (`GET /api/race/live`, `lib/race-live.ts`), so
 * both surfaces are the same screen by construction and every rule here is
 * unit-tested without a browser. The feed decides the order; this module only
 * decides whether and how to draw it. It is import-safe from client code.
 */

import { SESSION_STATE } from "./events";
import { RACE_DROP_AFTER_S, type LiveRace, type LiveRaceRow } from "./race-live";
import { formatGap } from "./time";

/**
 * How often a screen showing the race asks the feed again. The rigs report
 * every 2-3 s, so polling slower than that holds a pass off the screen for
 * longer than the feed does; faster only repeats the same answer.
 */
export const RACE_POLL_MS = 2_500;

/**
 * How long one request to the feed may take before the screen gives up on
 * it and counts it as a failure. Longer than a healthy answer by a wide
 * margin, shorter than two polls, so a slow route cannot pile requests up
 * and a hung one cannot freeze the race on the wall (`race-feed-poller.ts`).
 */
export const RACE_FEED_TIMEOUT_MS = 4_000;

/**
 * How long the finishing order stays on screen after the chequered flag,
 * counted from the first report that showed it. The room wants to see who
 * won; it does not want the standings to snap back while the last cars are
 * still crossing the line.
 */
export const RACE_FINISH_HOLD_MS = 60_000;

/** A race screen needs a field: one rig in a race session is a test drive. */
export const RACE_MIN_RIGS = 2;

/** How long a row that just changed place is marked as having moved. */
export const RACE_MOVE_HIGHLIGHT_MS = 4_000;

/** A row that just changed place, for the screen to mark for a few seconds. */
export type RaceMove = {
  /** Places gained (positive) or lost (negative). */
  delta: number;
  /** Bumped on every move of this rig, so a second move restarts the mark. */
  seq: number;
};

/** The feed's one race, as last accepted for the screen. */
export type RaceBoardState = {
  /** The race on screen, or null when the screen shows the standings. */
  race: LiveRace | null;
  /** When `race` was accepted, by the screen's own clock. */
  raceAt: number;
  /**
   * The flag the screen has seen, remembered by session so a race that has
   * had its minute does not come back when its rigs are still reporting the
   * flag, while the next race - a new session - shows as soon as it starts.
   */
  finish: { sessionKey: string; flagAt: number } | null;
};

export const INITIAL_RACE_BOARD: RaceBoardState = { race: null, raceAt: 0, finish: null };

/** One race, for the finish memory: the feed's own session identity. */
export function sessionKey(race: LiveRace): string | null {
  return race.session ? `${race.session.sessionUniqueId}:${race.session.sessionNum}` : null;
}

/** Whether the feed is reporting a race the screen can draw: a Race session with a field. */
export function isLiveRace(feed: LiveRace): boolean {
  return feed.session !== null && feed.session.isRace && feed.rows.length >= RACE_MIN_RIGS;
}

/** The flag is out: the session has reached the chequered flag or the cool-down after it. */
export function isFinished(feed: LiveRace): boolean {
  return feed.session !== null && feed.session.sessionState >= SESSION_STATE.checkered;
}

/**
 * Applies one answer from the feed, at `now` by the screen's clock.
 *
 * - A race under way (any state before the flag) is the race on screen.
 * - A race under the flag stays on screen for RACE_FINISH_HOLD_MS from the
 *   first report that showed the flag, still updating while cars cross the
 *   line, then gives the screen back to the standings even though its rigs
 *   may report the flag for longer. The finish is remembered by session, so
 *   that race does not return, and a session that goes back under green (a
 *   restart) forgets its flag.
 * - A feed with no race in it keeps a finished race on screen through its
 *   hold - the rigs leave the session at the flag and their rows go stale
 *   and drop - and otherwise clears the screen.
 * - A race the feed stopped answering about (`applyRaceFeedFailure`) is kept
 *   only as long as the feed itself would keep a silent rig,
 *   RACE_DROP_AFTER_S, so a dead feed cannot freeze a race on the wall.
 */
export function applyRaceFeed(state: RaceBoardState, feed: LiveRace, now: number): RaceBoardState {
  if (!isLiveRace(feed)) {
    return keepFinish(state, now) ? state : { ...state, race: null };
  }
  const key = sessionKey(feed)!;
  if (!isFinished(feed)) {
    const finish = state.finish?.sessionKey === key ? null : state.finish;
    return { race: feed, raceAt: now, finish };
  }
  const finish =
    state.finish?.sessionKey === key ? state.finish : { sessionKey: key, flagAt: now };
  const onScreen = now - finish.flagAt < RACE_FINISH_HOLD_MS;
  return { race: onScreen ? feed : null, raceAt: now, finish };
}

/** The feed did not answer: keep what is on screen until it is as old as the feed's own drop. */
export function applyRaceFeedFailure(state: RaceBoardState, now: number): RaceBoardState {
  if (state.race && now - state.raceAt > RACE_DROP_AFTER_S * 1000) {
    return { ...state, race: null };
  }
  return state;
}

/** Whether the race on screen is a finished one still inside its hold. */
function keepFinish(state: RaceBoardState, now: number): boolean {
  if (!state.race || !state.finish) return false;
  return (
    state.finish.sessionKey === sessionKey(state.race) &&
    now - state.finish.flagAt < RACE_FINISH_HOLD_MS
  );
}

/**
 * Places gained (positive) or lost (negative) per rig between two answers
 * from the feed, for the screen to mark as a pass.
 *
 * A pass is a change of ORDER among the rigs on both answers, not a change
 * of place number. The feed renumbers `place` from 1 every answer, so a rig
 * that drops out (its row aged off) moves every car behind it up a number,
 * and a rig that joins ahead (a late starter, a rig back from a silent spell)
 * moves every car behind it down one - and nobody passed anybody. So the rigs
 * present on both answers are put in their old order and their new order,
 * and a rig is marked by how many of THOSE it gained or lost on; a rig on
 * only one answer is neither marked nor counted. A rig new to the board has
 * nothing to have moved from, and neither has any rig when the answers are
 * different sessions: the next race's grid is not a pass on the last one's
 * finish. Keyed by rig number, which is what identifies a row across answers
 * whether or not anyone is signed in on it.
 */
export function placeChanges(before: LiveRace | null, after: LiveRace): Map<number, number> {
  const moves = new Map<number, number>();
  if (!before || sessionKey(before) !== sessionKey(after)) return moves;
  const afterRigs = new Set(after.rows.map((row) => row.rigNumber));
  const beforeRigs = new Set(before.rows.map((row) => row.rigNumber));
  const wasAt = new Map<number, number>();
  for (const row of sortedByPlace(before.rows)) {
    if (afterRigs.has(row.rigNumber)) wasAt.set(row.rigNumber, wasAt.size);
  }
  let nowAt = 0;
  for (const row of sortedByPlace(after.rows)) {
    if (!beforeRigs.has(row.rigNumber)) continue;
    const was = wasAt.get(row.rigNumber)!;
    if (was !== nowAt) moves.set(row.rigNumber, was - nowAt);
    nowAt += 1;
  }
  return moves;
}

/** The feed returns rows in `place` order already; sorting is defence against one that does not. */
function sortedByPlace(rows: readonly LiveRaceRow[]): LiveRaceRow[] {
  return [...rows].sort((a, b) => a.place - b.place);
}

/** Who is in the seat, or the rig itself when nobody is signed in. */
export function rowName(row: Pick<LiveRaceRow, "driverName" | "rigNumber">): string {
  return row.driverName ?? `Rig ${row.rigNumber}`;
}

/** The session's state, in the room's words. */
export function sessionStateLabel(sessionState: number): string {
  switch (sessionState) {
    case SESSION_STATE.getInCar:
      return "Gridding";
    case SESSION_STATE.warmup:
      return "Warm-up";
    case SESSION_STATE.paradeLaps:
      return "Formation lap";
    case SESSION_STATE.racing:
      return "Racing";
    case SESSION_STATE.checkered:
      return "Chequered flag";
    case SESSION_STATE.coolDown:
      return "Finished";
    default:
      return "Race";
  }
}

/**
 * What is left of the session: laps when the race is run to a lap count,
 * otherwise time, otherwise nothing (an untimed session). Nothing is left
 * once the flag is out. iRacing's laps remaining counts the lap under way,
 * so one is the last lap, not one more after it.
 */
export function remainingLabel(session: {
  sessionState: number;
  lapsRemain: number | null;
  timeRemainS: number | null;
}): string | null {
  if (session.sessionState >= SESSION_STATE.checkered) return null;
  if (session.lapsRemain !== null) {
    if (session.lapsRemain <= 1) return "Final lap";
    return `${session.lapsRemain} laps to go`;
  }
  if (session.timeRemainS !== null) {
    const total = Math.max(0, Math.round(session.timeRemainS));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")} to go`;
  }
  return null;
}

/** A gap in seconds as the lap boards print one: "+1.234", "+1:01.204"; "—" for none. */
export function formatRaceGap(seconds: number | null): string {
  if (seconds === null) return "—";
  const text = formatGap(Math.round(seconds * 1000));
  return text === "" ? "—" : text;
}
