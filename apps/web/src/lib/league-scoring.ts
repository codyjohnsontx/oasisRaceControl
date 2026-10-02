/**
 * SEASON SCORING - the single, swappable rule.
 *
 * Placing drivers in a round happens in one query (queryRoundResults in
 * league-queries.ts): by the race finishing order when the round has a race
 * result, otherwise by best valid lap. Turning a place into points, and rolling
 * rounds up into a season, is this file and nothing else: change
 * `POINTS_BY_POSITION`, `PARTICIPATION_POINTS`, `QUALIFYING_BONUS_POINTS` or
 * `roundPoints()` and every standings surface follows. Nothing else in the
 * codebase encodes points.
 *
 * THE RULE, as the venue runs it:
 *   P1..P5 score 5, 4, 3, 2, 1.
 *   Everyone else who took part scores 1 point - including a driver who showed
 *   up and never set a clean lap, and a driver who qualified but has no race
 *   finish.
 *   A round with a race result (league night: open qualifying, then a race in
 *   one hosted iRacing session) is placed by the race, and the driver with the
 *   fastest valid qualifying lap scores 1 more on top of whatever the race
 *   gave them.
 *   A round with no race result is placed by fastest valid lap, with no bonus -
 *   P1 already is the fastest lap there. Rounds from before races were
 *   recorded score exactly as they always did.
 *   Season total = sum of every round entered. No drops.
 *
 * P5 and the participation point are both 1. That is the rule as given, not an
 * oversight: fifth place and turning up are worth the same, and the scale is
 * deliberately short.
 *
 * WHY A FIXED TABLE:
 *   - It is fair across uneven Wednesdays. League night attendance swings
 *     between ~8 and ~20 drivers; a field-size rule (points = N - pos) would
 *     make a win on a busy night worth triple a win on a quiet one.
 *   - The participation point rewards turning up, which is the behaviour a
 *     weekly shop league wants to grow, without letting attendance alone
 *     outrank pace - five nights of showing up still lose to a single win.
 *   - No drop weeks: they get a named seam below rather than an implementation
 *     nobody asked for.
 *
 * A short scale ties often, so the tiebreak below does real work: two drivers
 * on equal points is the normal case here, not the exotic one.
 *
 * EASY KNOBS (each is a one-line change here):
 *   - Different table: edit POINTS_BY_POSITION.
 *   - No participation point: set PARTICIPATION_POINTS to 0.
 *   - No qualifying bonus: set QUALIFYING_BONUS_POINTS to 0.
 *   - Drop weeks: in computeSeasonStandings, sort each driver's per-round
 *     points and skip the lowest N before summing.
 */

import type { RoundResult } from "./league";

/** Points for P1..P5. Index 0 is P1. */
export const POINTS_BY_POSITION = [5, 4, 3, 2, 1] as const;

/** Awarded to every entrant who finishes outside the table, or is not placed. */
export const PARTICIPATION_POINTS = 1;

/** On top of the race points, for the fastest valid qualifying lap of a raced round. */
export const QUALIFYING_BONUS_POINTS = 1;

/** Human-readable summary of the active rule, rendered on the standings page
 *  so the shop floor can see what it is without reading code. */
export const SCORING_RULE_SUMMARY =
  `P1-P${POINTS_BY_POSITION.length}: ${POINTS_BY_POSITION.join(", ")} · ` +
  `everyone else who takes part: ${PARTICIPATION_POINTS} · ` +
  `fastest qualifying lap on a race night: +${QUALIFYING_BONUS_POINTS}`;

/**
 * Whether this result earns the qualifying bonus: the fastest valid qualifying
 * lap of a round placed by its race. Never in a round without a race, where
 * the fastest lap already is P1.
 */
export function isFastestQualifier(
  result: Pick<RoundResult, "raced" | "qualifying_position">,
): boolean {
  return result.raced && result.qualifying_position === 1;
}

/**
 * Points for one driver in one round. `position` is null when the driver took
 * part but is not placed - no valid lap, or no race finish in a raced round.
 */
export function roundPoints(
  result: Pick<RoundResult, "position" | "raced" | "qualifying_position">,
): number {
  const placed =
    result.position === null
      ? PARTICIPATION_POINTS
      : (POINTS_BY_POSITION[result.position - 1] ?? PARTICIPATION_POINTS);
  return placed + (isFastestQualifier(result) ? QUALIFYING_BONUS_POINTS : 0);
}

export type StandingRoundEntry = {
  round_id: string;
  round_number: number;
  position: number | null;
  best_lap_ms: number | null;
  /** The round was placed by its race rather than by fastest lap. */
  raced: boolean;
  /** Took the qualifying bonus, which `points` already includes. */
  fastest_qualifier: boolean;
  points: number;
};

export type SeasonStanding = {
  driver_id: string;
  display_name: string;
  points: number;
  rounds_entered: number;
  wins: number;
  podiums: number;
  best_position: number | null;
  /** Per-round breakdown, in round order - drives the season grid. */
  rounds: StandingRoundEntry[];
};

/**
 * Season standings from every round result in the season.
 *
 * Open rounds are included on purpose: the wall board should show the season
 * moving while Wednesday night is still running. Closed rounds stop moving
 * because their lap window is frozen (see v_league_round_laps) and nothing
 * writes their race result any more (lib/race-results.ts).
 *
 * Tiebreak, in order: points, then wins, then podiums, then rounds entered,
 * then name - so a tie on the board is always broken by something a driver can
 * see, and the order never flickers between polls.
 */
export function computeSeasonStandings(results: RoundResult[]): SeasonStanding[] {
  const byDriver = new Map<string, SeasonStanding>();

  for (const result of results) {
    let standing = byDriver.get(result.driver_id);
    if (!standing) {
      standing = {
        driver_id: result.driver_id,
        display_name: result.display_name,
        points: 0,
        rounds_entered: 0,
        wins: 0,
        podiums: 0,
        best_position: null,
        rounds: [],
      };
      byDriver.set(result.driver_id, standing);
    }

    const points = roundPoints(result);
    standing.points += points;
    standing.rounds_entered += 1;
    if (result.position === 1) standing.wins += 1;
    if (result.position !== null && result.position <= 3) standing.podiums += 1;
    if (
      result.position !== null &&
      (standing.best_position === null || result.position < standing.best_position)
    ) {
      standing.best_position = result.position;
    }
    standing.rounds.push({
      round_id: result.round_id,
      round_number: result.round_number,
      position: result.position,
      best_lap_ms: result.best_lap_ms,
      raced: result.raced,
      fastest_qualifier: isFastestQualifier(result),
      points,
    });
  }

  const standings = [...byDriver.values()];
  for (const standing of standings) {
    standing.rounds.sort((a, b) => a.round_number - b.round_number);
  }

  return standings.sort(
    (a, b) =>
      b.points - a.points ||
      b.wins - a.wins ||
      b.podiums - a.podiums ||
      b.rounds_entered - a.rounds_entered ||
      // Fixed locale: the runtime default varies by machine and ICU build, and
      // the wall board must not reorder itself between two servers. driver_id
      // then makes the comparator a total order regardless of the display_name
      // uniqueness the schema happens to enforce.
      a.display_name.localeCompare(b.display_name, "en-US") ||
      (a.driver_id < b.driver_id ? -1 : a.driver_id > b.driver_id ? 1 : 0),
  );
}
