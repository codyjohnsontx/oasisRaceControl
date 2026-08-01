/**
 * League night - shared types and pure helpers.
 *
 * A league runs one season at a time; a season is a run of weekly rounds; a
 * round pins one track/car combo for the night. Rounds rank the full field by
 * each driver's best valid lap; rounds roll up into season standings via the
 * single scoring rule in league-scoring.ts.
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

/**
 * One driver's result in one round. `position` is null when the driver took
 * part but never set a valid lap - they are still in the field, still on the
 * board, and still score the participation point.
 */
export type RoundResult = {
  round_id: string;
  round_number: number;
  round_name: string;
  round_date: string;
  closed: boolean;
  driver_id: string;
  display_name: string;
  position: number | null;
  best_lap_ms: number | null;
  best_lap_at: string | null;
  lap_count: number;
  valid_lap_count: number;
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
 * Most laps one round request returns. Reachable on a long night (25 rigs on
 * two-minute laps for four hours is roughly 3000), so callers are told when
 * they hit it rather than silently receiving a subset - see getRoundLaps.
 */
export const ROUND_LAP_CAP = 2000;

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

/** Group a round's laps by driver, preserving each driver's lap order. */
export function lapsByDriver(laps: RoundLap[]): Record<string, RoundLap[]> {
  const grouped: Record<string, RoundLap[]> = {};
  for (const lap of laps) {
    (grouped[lap.driver_id] ??= []).push(lap);
  }
  return grouped;
}
