import { describe, expect, it } from "vitest";
import type { RoundResult } from "./league";
import {
  PARTICIPATION_POINTS,
  POINTS_BY_POSITION,
  computeSeasonStandings,
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
    ...overrides,
  };
}

describe("roundPoints", () => {
  it("pays the table for scoring positions", () => {
    expect(roundPoints({ position: 1 })).toBe(POINTS_BY_POSITION[0]);
    expect(roundPoints({ position: 3 })).toBe(POINTS_BY_POSITION[2]);
    expect(roundPoints({ position: POINTS_BY_POSITION.length })).toBe(
      POINTS_BY_POSITION[POINTS_BY_POSITION.length - 1],
    );
  });

  it("pays participation outside the table", () => {
    expect(roundPoints({ position: POINTS_BY_POSITION.length + 1 })).toBe(
      PARTICIPATION_POINTS,
    );
  });

  it("pays participation to a driver who set no valid lap", () => {
    expect(roundPoints({ position: null })).toBe(PARTICIPATION_POINTS);
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

  it("breaks a points tie on wins, then podiums", () => {
    // Both total 26: a win plus a nowhere finish, versus two solid ones.
    const standings = computeSeasonStandings([
      result({ driver_id: "winner", display_name: "Zoe", position: 1 }),
      result({
        driver_id: "winner",
        display_name: "Zoe",
        round_id: "round-2",
        round_number: 2,
        position: 30,
      }),
      result({ driver_id: "steady", display_name: "Abe", position: 2 }),
      result({
        driver_id: "steady",
        display_name: "Abe",
        round_id: "round-2",
        round_number: 2,
        position: 6,
      }),
    ]);

    expect(standings[0].points).toBe(standings[1].points);
    expect(standings[0].driver_id).toBe("winner");
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
});
