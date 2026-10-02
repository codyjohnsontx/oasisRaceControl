/**
 * League night - shared types and pure helpers.
 *
 * A league runs one season at a time; a season is a run of weekly rounds; a
 * round pins one track/car combo for the night. A round with a race result is
 * placed by its finishing order, any other round by each driver's best valid
 * lap; rounds roll up into season standings via the single scoring rule in
 * league-scoring.ts.
 *
 * This module is import-safe from client components (no database). The SQL
 * lives in league-queries.ts, which is server-only - same split as
 * leaderboards.ts / leaderboards-queries.ts.
 */

import { trackLabel } from "./leaderboards";

/** A round, joined up to its season and league for display. */
export type LeagueRound = {
  id: string;
  season_id: string;
  season_name: string;
  league_name: string;
  round_number: number;
  name: string | null;
  round_date: string; // YYYY-MM-DD, venue-local
  track_name: string;
  track_config: string | null;
  car_name: string;
  incident_limit: number;
  opened_at: string;
  closed_at: string | null;
};

/** How a driver's race place was recorded (`league_race_results.source`). */
export type FinishSource = "flag" | "close" | "staff";

/**
 * One driver's row in one round, as the database holds it, before
 * league-scoring.ts places it. The field is every driver with a lap attributed
 * to the round or a race entry in it.
 */
export type RoundEntry = {
  round_id: string;
  round_number: number;
  driver_id: string;
  display_name: string;
  /** Best valid lap anywhere in the round, race laps included. */
  best_lap_ms: number | null;
  lap_count: number;
  valid_lap_count: number;
  /**
   * Best valid qualifying lap, and its rank in the round: laps completed before
   * the round's race went green, or every lap in a round with no race. Null
   * when the driver set no valid qualifying lap.
   */
  qualifying_lap_ms: number | null;
  qualifying_position: number | null;
  /**
   * The race place as recorded - iRacing's at the flag, or what staff entered.
   * It can skip a number (a car nobody was signed in to) or repeat one (two
   * rigs mid-update), which is why it is not the driver's `position`. Null
   * with a `finish_source` is a staff-marked DNF.
   */
  finish_position: number | null;
  /** Null when the driver has no race entry in this round. */
  finish_source: FinishSource | null;
};

/**
 * One driver's result in one round, placed by `rankRound` in
 * league-scoring.ts. `position` is where the round puts the driver: the race
 * finishing order when the round has a race result, otherwise the rank by best
 * valid lap. Null when the driver took part but is not placed - no valid lap,
 * or no race finish in a raced round. They are still in the field, still on
 * the board, and still score the participation point.
 */
export type RoundResult = RoundEntry & {
  position: number | null;
  /** The round is scored by its race result. The same on every row of a round. */
  raced: boolean;
  /** Earns the qualifying bonus: the fastest valid qualifying lap of a raced round. */
  fastest_qualifier: boolean;
};

/** A single lap inside a round, for the expanded driver view. */
export type RoundLap = {
  id: string;
  driver_id: string;
  lap_number: number | null;
  lap_time_ms: number;
  incident_delta: number | null;
  is_valid: boolean;
  invalid_reason: string | null;
  completed_at: string;
};

export type LeagueSeason = {
  id: string;
  league_id: string;
  league_name: string;
  name: string;
  started_on: string;
  ended_on: string | null;
};

/**
 * Most drivers whose laps one round request may ask for. A round's whole field
 * fits well inside this; the cap keeps a crafted query from asking for
 * thousands of drivers at once. Shared so the round page never builds a URL the
 * API would reject.
 */
export const MAX_ROUND_DRIVERS = 60;

/**
 * Most laps one unfiltered round request returns - the whole round rendered
 * into one page. Reachable on a long night (25 rigs on two-minute laps for four
 * hours is roughly 3000), so callers are told when they hit it rather than
 * silently receiving a subset - see getRoundLaps.
 */
export const ROUND_LAP_CAP = 2000;

/**
 * Most laps one named driver returns. A request that names drivers gets this
 * budget per driver instead of sharing ROUND_LAP_CAP across the set: asking for
 * a driver means wanting that driver's laps in full, and one shared budget spent
 * in `completed_at` order hands the drivers still running a short list or an
 * empty one. Four hours of one-minute laps is roughly 240, so this is a safety
 * rail rather than a page size.
 */
export const DRIVER_LAP_CAP = 500;

// ---- Pure helpers (unit-tested; no DB) ------------------------------------

/** "Week 3" if staff named it, otherwise "Round 3". */
export function roundLabel(round: Pick<LeagueRound, "name" | "round_number">): string {
  return round.name?.trim() || `Round ${round.round_number}`;
}

/** "Spa-Francorchamps - Grand Prix Pits · Porsche 911 GT3 R" */
export function comboLabel(
  round: Pick<LeagueRound, "track_name" | "track_config" | "car_name">,
): string {
  return `${trackLabel(round)} · ${round.car_name}`;
}

/**
 * Customer-facing wording for why a lap doesn't count. The enum names are
 * written for staff and the audit log; a driver on their phone gets the short
 * version, and anything unmapped degrades to the enum with the underscores
 * taken out rather than to nothing.
 */
// A Map, not an object: the lookup key is a database string, and a plain
// object would resolve inherited keys like "constructor" to something that is
// not a label at all.
const INVALID_REASON_LABELS = new Map<string, string>([
  ["INCIDENT_LIMIT_EXCEEDED", "incident"],
  ["OFF_TRACK", "off track"],
  ["PIT_LANE_LAP", "pit lap"],
  ["INCOMPLETE_LAP", "incomplete"],
  ["SESSION_RESET", "session reset"],
  ["WRONG_TRACK_CONFIGURATION", "wrong layout"],
  ["WRONG_CAR", "wrong car"],
  ["WRONG_CAR_CLASS", "wrong class"],
  ["WRONG_SETUP_MODE", "wrong setup"],
  ["WRONG_CHALLENGE_CONFIGURATION", "wrong config"],
  ["DUPLICATE_EVENT", "duplicate"],
  ["MANUALLY_INVALIDATED", "voided by staff"],
]);

export function invalidReasonLabel(reason: string | null): string {
  if (!reason) return "invalid";
  return INVALID_REASON_LABELS.get(reason) ?? reason.replaceAll("_", " ").toLowerCase();
}

/**
 * Whether the round holds more laps than one unfiltered request returns.
 *
 * This is a different fact from the `truncated` a filtered getRoundLaps() call
 * reports: that one is about the drivers that request asked for, and a poll
 * asking for one expanded row is almost never truncated even on a round that
 * is. Derived from the field's own lap counts (the same laps getRoundLaps
 * counts, active drivers only) so it costs no extra query and stays true while
 * the round grows.
 */
export function roundLapsTruncated(field: Pick<RoundResult, "lap_count">[]): boolean {
  return field.reduce((sum, row) => sum + row.lap_count, 0) > ROUND_LAP_CAP;
}

/** Group a round's laps by driver, preserving each driver's lap order. */
export function lapsByDriver(laps: RoundLap[]): Record<string, RoundLap[]> {
  const grouped: Record<string, RoundLap[]> = {};
  for (const lap of laps) {
    (grouped[lap.driver_id] ??= []).push(lap);
  }
  return grouped;
}
