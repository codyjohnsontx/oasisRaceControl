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

// ---- Pure helpers (unit-tested; no DB) ------------------------------------

/** Stable board identity: track + layout. */
export function trackKey(t: { track_name: string; track_config: string | null }): string {
  return `${t.track_name}|${t.track_config ?? ""}`;
}

/** Human label, e.g. "Spa-Francorchamps — Grand Prix Pits" (config omitted when null). */
export function trackLabel(t: { track_name: string; track_config: string | null }): string {
  return `${t.track_name}${t.track_config ? ` — ${t.track_config}` : ""}`;
}
