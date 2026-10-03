import { describe, expect, it } from "vitest";
import type { RoundResult } from "./league";
import {
  PARTICIPATION_POINTS,
  POINTS_BY_POSITION,
  QUALIFYING_BONUS_POINTS,
  computeSeasonStandings,
  isFastestQualifier,
  roundPoints,
} from "./league-scoring";

function result(overrides: Partial<RoundResult> & { driver_id: string }): RoundResult {
  return {
    round_id: "round-1",
    round_number: 1,
    display_name: overrides.driver_id,
    position: null,
    best_lap_ms: null,
    lap_count: 0,
    valid_lap_count: 0,
    raced: false,
    qualifying_lap_ms: null,
    qualifying_position: null,
    qualifying_lap_count: 0,
    finish_source: null,
    ...overrides,
  };
}

/** A place in a round with no race result, ranked by fastest lap as every
 *  round was before races were recorded. */
const lapRound = (position: number | null) => ({
  position,
  raced: false,
  qualifying_position: position,
});

/** A place in a raced round, with where the driver qualified. */
const raceRound = (position: number | null, qualifying_position: number | null = null) => ({
  position,
  raced: true,
  qualifying_position,
});

describe("roundPoints", () => {
  it("pays the table for scoring positions", () => {
    expect(roundPoints(lapRound(1))).toBe(POINTS_BY_POSITION[0]);
    expect(roundPoints(lapRound(3))).toBe(POINTS_BY_POSITION[2]);
    expect(roundPoints(lapRound(POINTS_BY_POSITION.length))).toBe(
      POINTS_BY_POSITION[POINTS_BY_POSITION.length - 1],
    );
  });

  it("pays participation outside the table", () => {
    expect(roundPoints(lapRound(POINTS_BY_POSITION.length + 1))).toBe(
      PARTICIPATION_POINTS,
    );
  });

  it("pays participation to a driver who set no valid lap", () => {
    expect(roundPoints(lapRound(null))).toBe(PARTICIPATION_POINTS);
  });
});

describe("roundPoints in a round with a race result", () => {
  it("pays the table for the finishing order", () => {
    expect(roundPoints(raceRound(1, 4))).toBe(POINTS_BY_POSITION[0]);
    expect(roundPoints(raceRound(5, 2))).toBe(POINTS_BY_POSITION[4]);
    expect(roundPoints(raceRound(6, 3))).toBe(PARTICIPATION_POINTS);
  });

  it("adds the bonus for the fastest qualifying lap on top of the race", () => {
    expect(roundPoints(raceRound(1, 1))).toBe(POINTS_BY_POSITION[0] + QUALIFYING_BONUS_POINTS);
    expect(roundPoints(raceRound(9, 1))).toBe(PARTICIPATION_POINTS + QUALIFYING_BONUS_POINTS);
  });

  it("pays participation, and still the bonus, to a driver with no race finish", () => {
    // Qualified but crashed out, stopped reporting, or was marked DNF.
    expect(roundPoints(raceRound(null, 3))).toBe(PARTICIPATION_POINTS);
    expect(roundPoints(raceRound(null, 1))).toBe(PARTICIPATION_POINTS + QUALIFYING_BONUS_POINTS);
    // Raced without ever setting a clean qualifying lap.
    expect(roundPoints(raceRound(2, null))).toBe(POINTS_BY_POSITION[1]);
  });

  it("gives no bonus in a round with no race, where P1 already is the fastest lap", () => {
    expect(roundPoints(lapRound(1))).toBe(POINTS_BY_POSITION[0]);
    expect(isFastestQualifier({ raced: false, qualifying_position: 1 })).toBe(false);
    expect(isFastestQualifier({ raced: true, qualifying_position: 1 })).toBe(true);
    expect(isFastestQualifier({ raced: true, qualifying_position: 2 })).toBe(false);
  });
});

describe("computeSeasonStandings", () => {
  it("sums points across rounds and ranks by total", () => {
    // Round 2 is fed before round 1 for both drivers: the query orders by
    // round, but nothing guarantees that, and the per-driver round list drives
    // the season grid on the wall. Ascending input would assert nothing.
    const standings = computeSeasonStandings([
      result({ driver_id: "a", round_id: "round-2", round_number: 2, position: 3 }),
      result({ driver_id: "b", round_id: "round-2", round_number: 2, position: 1 }),
      result({ driver_id: "a", position: 1 }),
      result({ driver_id: "b", position: 2 }),
    ]);

    expect(standings.map((s) => s.driver_id)).toEqual(["b", "a"]);
    expect(standings[0].points).toBe(POINTS_BY_POSITION[1] + POINTS_BY_POSITION[0]);
    expect(standings[1].points).toBe(POINTS_BY_POSITION[0] + POINTS_BY_POSITION[2]);
    expect(standings[0].rounds.map((r) => r.round_number)).toEqual([1, 2]);
    expect(standings[1].rounds.map((r) => r.round_number)).toEqual([1, 2]);
  });

  it("counts wins, podiums, best finish and rounds entered", () => {
    const standings = computeSeasonStandings([
      result({ driver_id: "a", position: 1 }),
      result({ driver_id: "a", round_id: "round-2", round_number: 2, position: 3 }),
      result({ driver_id: "a", round_id: "round-3", round_number: 3, position: null }),
    ]);

    expect(standings[0]).toMatchObject({
      wins: 1,
      podiums: 2,
      best_position: 1,
      rounds_entered: 3,
    });
  });

  it("breaks a points tie on wins", () => {
    // Both total 6 on the venue's 5/4/3/2/1 scale: a win plus a fifth, versus
    // a second plus a fourth. Ties like this are the normal case on a scale
    // this short, which is why the tiebreak is not decoration.
    const standings = computeSeasonStandings([
      result({ driver_id: "winner", display_name: "Zoe", position: 1 }),
      result({
        driver_id: "winner",
        display_name: "Zoe",
        round_id: "round-2",
        round_number: 2,
        position: 5,
      }),
      result({ driver_id: "steady", display_name: "Abe", position: 2 }),
      result({
        driver_id: "steady",
        display_name: "Abe",
        round_id: "round-2",
        round_number: 2,
        position: 4,
      }),
    ]);

    expect(standings[0].points).toBe(standings[1].points);
    expect(standings.map((s) => s.driver_id)).toEqual(["winner", "steady"]);
  });

  it("breaks a points tie with equal wins on podiums", () => {
    // Both total 6 with no wins: one podium against none. Name order would put
    // "Abe" first, so this only passes if podiums are compared before the name.
    const standings = computeSeasonStandings([
      result({ driver_id: "podium", display_name: "Zoe", position: 2 }),
      result({
        driver_id: "podium",
        display_name: "Zoe",
        round_id: "round-2",
        round_number: 2,
        position: 4,
      }),
      ...[4, 4, 5, 5].map((position, index) =>
        result({
          driver_id: "grinder",
          display_name: "Abe",
          round_id: `round-${index + 1}`,
          round_number: index + 1,
          position,
        }),
      ),
    ]);

    expect(standings[0].points).toBe(standings[1].points);
    expect(standings[0]).toMatchObject({ driver_id: "podium", wins: 0, podiums: 1 });
    expect(standings[1]).toMatchObject({ driver_id: "grinder", wins: 0, podiums: 0 });
  });

  it("pays fifth place and mere participation the same, by design", () => {
    // The venue's rule ends at P5 = 1 and pays 1 for turning up, so these two
    // land on the same number through different branches of roundPoints.
    expect(roundPoints(lapRound(POINTS_BY_POSITION.length))).toBe(PARTICIPATION_POINTS);
    expect(roundPoints(lapRound(null))).toBe(PARTICIPATION_POINTS);
    expect(roundPoints(lapRound(POINTS_BY_POSITION.length + 1))).toBe(
      PARTICIPATION_POINTS,
    );
  });

  it("orders a dead-heat by name so the board never flickers", () => {
    const standings = computeSeasonStandings([
      result({ driver_id: "z", display_name: "Zoe", position: 5 }),
      result({ driver_id: "a", display_name: "Abe", position: 5 }),
    ]);

    expect(standings.map((s) => s.display_name)).toEqual(["Abe", "Zoe"]);
  });

  it("includes a driver who took part but never set a valid lap", () => {
    const standings = computeSeasonStandings([
      result({ driver_id: "a", position: 1 }),
      result({ driver_id: "b", position: null, lap_count: 4, valid_lap_count: 0 }),
    ]);

    expect(standings).toHaveLength(2);
    expect(standings[1]).toMatchObject({
      driver_id: "b",
      points: PARTICIPATION_POINTS,
      best_position: null,
    });
  });

  it("adds race rounds, bonus included, to rounds scored by fastest lap", () => {
    const standings = computeSeasonStandings([
      // Round 1 from before races were recorded: placed by fastest lap.
      result({ driver_id: "a", position: 1, qualifying_position: 1 }),
      result({ driver_id: "b", position: 2, qualifying_position: 2 }),
      // Round 2 was raced: b won it, a took the fastest qualifying lap and
      // crashed out.
      result({
        driver_id: "b",
        round_id: "round-2",
        round_number: 2,
        raced: true,
        position: 1,
        qualifying_position: 2,
        finish_source: "flag",
      }),
      result({
        driver_id: "a",
        round_id: "round-2",
        round_number: 2,
        raced: true,
        position: null,
        qualifying_position: 1,
      }),
    ]);

    expect(standings.map((s) => [s.driver_id, s.points, s.wins])).toEqual([
      ["b", POINTS_BY_POSITION[1] + POINTS_BY_POSITION[0], 1],
      ["a", POINTS_BY_POSITION[0] + PARTICIPATION_POINTS + QUALIFYING_BONUS_POINTS, 1],
    ]);
    const a = standings.find((s) => s.driver_id === "a")!;
    expect(a.rounds.map((r) => [r.raced, r.fastest_qualifier, r.points])).toEqual([
      [false, false, POINTS_BY_POSITION[0]],
      [true, true, PARTICIPATION_POINTS + QUALIFYING_BONUS_POINTS],
    ]);
  });
});
