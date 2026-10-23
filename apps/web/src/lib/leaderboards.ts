/**
 * Browsable per-track leaderboards — shared types + pure helpers. A "board" is
 * a track + car combo (track_name + track_config + car_name); each board ranks
 * every active driver's single fastest valid lap. Two windows: all-time and
 * tonight.
 *
 * This module is import-safe from client components (no DB). The SQL lives in
 * leaderboards-queries.ts, which is server-only (imports pg).
 *
 * Combo identity uses the same coalesce(track_config,'') rule as
 * v_fastest_tonight and the check-in validity path — null config compares equal
 * to empty. There's no tracks table; combos are read straight off laps.
 */

/** A board is one track layout (track_name + track_config). The car isn't part
 *  of board identity — a driver's fastest lap is ranked across any car and the
 *  car is shown on the row. Layout (config) stays in identity because a
 *  different layout is a different length and isn't comparable. */
export type Board = {
  track_name: string;
  track_config: string | null;
  driver_count: number;
  lap_count: number;
};

export type BoardRow = {
  driver_id: string;
  display_name: string;
  lap_time_ms: number;
  car_name: string;
  completed_at: string;
};

export type BoardWindow = "alltime" | "tonight";

/**
 * Row caps on a numeric `limit` to the `/api/leaderboard/tonight` feed. The
 * default is what the feed has always returned when no `limit` is asked for:
 * the wall's tonight board draws ten slots and the phone a little more. The
 * maximum is the public numeric contract the feed has always had. The event
 * view of `/tv` asks for neither - it asks for `limit=all`, because it promises
 * every driver with a lap today and any fixed ceiling would drop the next one
 * silently. Both live here, rather than in the route, because a Next route
 * file may export only its handlers and the route's tests need them too.
 */
export const TONIGHT_FEED_DEFAULT_ROWS = 15;
export const TONIGHT_FEED_MAX_ROWS = 200;

// ---- Pure helpers (unit-tested; no DB) ------------------------------------

/** Stable board identity: track + layout. */
export function trackKey(t: { track_name: string; track_config: string | null }): string {
  return `${t.track_name}|${t.track_config ?? ""}`;
}

/** Human label, e.g. "Spa-Francorchamps — Grand Prix Pits" (config omitted when null). */
export function trackLabel(t: { track_name: string; track_config: string | null }): string {
  return `${t.track_name}${t.track_config ? ` — ${t.track_config}` : ""}`;
}

// ---- Live tracks: what the rigs are driving right now ----------------------

/**
 * A track layout some rig is on right now, known from the rigs' heartbeats
 * rather than from laps. Every heartbeat names the session iRacing is in
 * (`heartbeatEvent.session` in `lib/events.ts`: track, layout, car, in the
 * strings laps are posted with), so a track joins the wall's rotation as soon
 * as a rig loads it - before anyone has finished a lap on it, which is what the
 * owner asked for (2026-10-23): a driver on an out-lap at a new track should
 * already see it on the screen. Heartbeats carry no driver, so neither does
 * this; it is a track, the cars seen on it, and how many rigs reported it.
 */
export type LiveTrack = {
  track_name: string;
  track_config: string | null;
  /** Distinct cars reported on this layout, in name order. */
  car_names: string[];
  /** Rigs that reported this layout inside the window. */
  rig_count: number;
};

/**
 * How long a track stays "live" after the last rig reported it. A live-only
 * track - one with no laps - leaves the rotation once no heartbeat has named
 * it for this long; a track with laps is in the rotation on its laps and never
 * reads this. Fifteen minutes is the owner's default: long enough that a rig
 * reloading the same track, or a heartbeat lost to a bad minute, does not
 * blink the board off the wall, and short enough that a track nobody is on
 * any more is gone before the next group sits down. Heartbeats come every
 * minute, so the window always holds several of them for a rig still there.
 */
export const LIVE_TRACK_WINDOW_MINUTES = 15;

/**
 * What `/api/leaderboards/boards` answers and the `/tv` page seeds the wall
 * with: every track with laps, and every track a rig is on right now. The two
 * lists are separate because they mean different things to the phone - the
 * `/leaderboards` picker reads only `listBoards()`, so a track with no laps is
 * never a pickable-but-empty board there - and `buildRotation` in
 * `components/tv/board-types.tsx` is the one place that puts them together.
 */
export type BoardsFeed = {
  boards: Board[];
  live: LiveTrack[];
};

/**
 * The order the rotation plays tracks in: by track name, then layout, with a
 * null layout first - the same order `listBoards()` asks the database for.
 * Live-only tracks are slotted into the boards with this, so they sit among
 * the tracks with laps where their name puts them rather than clumped at the
 * end. It is only ever used to place a live track between two boards: the
 * boards themselves keep the database's own order, so a collation that reads
 * two names differently from this comparison can at most put a live track one
 * slot off, never reorder a board.
 */
export function compareTracks(
  a: { track_name: string; track_config: string | null },
  b: { track_name: string; track_config: string | null },
): number {
  return (
    a.track_name.localeCompare(b.track_name, "en") ||
    (a.track_config ?? "").localeCompare(b.track_config ?? "", "en")
  );
}
