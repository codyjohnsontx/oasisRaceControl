/**
 * SEASON SCORING - the single, swappable rule.
 *
 * Ranking one round needs no rule at all (fastest valid lap wins). Rolling
 * rounds up into a season does, and the shop owner has not picked one yet, so
 * the whole rule lives in this file: change `POINTS_BY_POSITION`,
 * `PARTICIPATION_POINTS`, or `roundPoints()` and every standings surface
 * follows. Nothing else in the codebase encodes points.
 *
 * DEFAULT (chosen here, pending the shop owner's call):
 *   P1..P10 score 25, 18, 15, 12, 10, 8, 6, 4, 2, 1.
 *   Everyone else who took part scores 1 participation point - including a
 *   driver who showed up and never set a clean lap.
 *   Season total = sum of every round entered. No drops, no bonus points.
 *
 * WHY THIS DEFAULT:
 *   - A fixed table is fair across uneven Wednesdays. League night attendance
 *     swings between ~8 and ~20 drivers; a field-size rule (points = N - pos)
 *     would make a win on a busy night worth triple a win on a quiet one.
 *   - It is the table sim racers already read at a glance (F1 2010-2018,
 *     and the default in most iRacing club leagues), so nobody has to be
 *     taught the season table on the wall.
 *   - The participation point rewards turning up, which is the behaviour a
 *     weekly shop league actually wants to grow, without letting attendance
 *     alone outrank pace (10 nights of participation = 10 points, still less
 *     than a single win).
 *   - No drop weeks: they are the most commonly requested change, so they get
 *     a named seam below rather than an implementation nobody asked for.
 *
 * EASY KNOBS (each is a one-line change here):
 *   - Different table: edit POINTS_BY_POSITION.
 *   - No participation point: set PARTICIPATION_POINTS to 0.
 *   - Fastest lap bonus: not meaningful here - the round is ranked BY fastest
 *     lap, so P1 already is the fastest lap.
 *   - Drop weeks: in computeSeasonStandings, sort each driver's per-round
 *     points and skip the lowest N before summing.
 */

import type { RoundResult } from "./league";

/** Points for P1..P10. Index 0 is P1. */
export const POINTS_BY_POSITION = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1] as const;

/** Awarded to every entrant who finishes outside the table, or sets no valid lap. */
export const PARTICIPATION_POINTS = 1;

/** Human-readable summary of the active rule, rendered on the standings page
 *  so the shop floor can see what it is without reading code. */
export const SCORING_RULE_SUMMARY =
  `P1-P${POINTS_BY_POSITION.length}: ${POINTS_BY_POSITION.join(", ")} · ` +
  `everyone else who takes part: ${PARTICIPATION_POINTS}`;

/**
 * Points for one driver in one round. `position` is null when the driver took
 * part but set no valid lap.
 */
export function roundPoints(result: Pick<RoundResult, "position">): number {
  if (result.position === null) return PARTICIPATION_POINTS;
  return POINTS_BY_POSITION[result.position - 1] ?? PARTICIPATION_POINTS;
}

export type StandingRoundEntry = {
  round_id: string;
  round_number: number;
  position: number | null;
  best_lap_ms: number | null;
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
 * because their lap window is frozen (see v_league_round_laps).
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
      a.display_name.localeCompare(b.display_name),
  );
}
