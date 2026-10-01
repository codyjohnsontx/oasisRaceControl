import { describe, expect, it } from "vitest";
import { liveRace, RACE_STALE_AFTER_S, type RaceStatusRow } from "./race-live";

function report(overrides: Partial<RaceStatusRow>): RaceStatusRow {
  return {
    rig_number: 1,
    driver_id: null,
    driver_name: null,
    age_s: 1,
    session_unique_id: 500,
    session_num: 2,
    session_type: "Race",
    session_state: 4,
    session_flags: 4,
    session_time_remain_s: 900,
    session_laps_remain: null,
    car_idx: 0,
    position: null,
    class_position: null,
    lap: 3,
    laps_completed: 2,
    lap_dist_pct: 0.5,
    gap_to_leader_s: null,
    last_lap_ms: null,
    best_lap_ms: null,
    on_pit_road: false,
    incidents: 0,
    ...overrides,
  };
}

describe("liveRace", () => {
  it("is empty when no rig has reported", () => {
    expect(liveRace([])).toEqual({ session: null, rows: [], otherRigs: 0 });
  });

  it("orders by iRacing's position, so a pass reorders the board", () => {
    const before = liveRace([
      report({ rig_number: 1, position: 2 }),
      report({ rig_number: 2, position: 1 }),
      report({ rig_number: 3, position: 3 }),
    ]);
    expect(before.rows.map((r) => r.rigNumber)).toEqual([2, 1, 3]);

    const after = liveRace([
      report({ rig_number: 1, position: 1 }),
      report({ rig_number: 2, position: 2 }),
      report({ rig_number: 3, position: 3 }),
    ]);
    expect(after.rows.map((r) => r.rigNumber)).toEqual([1, 2, 3]);
  });

  it("numbers the board by place when two rigs report the same position either side of a pass", () => {
    // Rig 2 has just passed rig 1; rig 1's report predates the pass.
    const race = liveRace([
      report({ rig_number: 1, position: 2, laps_completed: 4, lap_dist_pct: 0.5 }),
      report({ rig_number: 2, position: 2, laps_completed: 4, lap_dist_pct: 0.52 }),
      report({ rig_number: 3, position: 1, laps_completed: 4, lap_dist_pct: 0.6 }),
    ]);
    expect(race.rows.map((r) => [r.rigNumber, r.position, r.place])).toEqual([
      [3, 1, 1],
      [2, 2, 2],
      [1, 2, 3],
    ]);
  });

  it("puts an unclassified car after every classified one, furthest round first", () => {
    const race = liveRace([
      report({ rig_number: 1, position: null, laps_completed: 1, lap_dist_pct: 0.2 }),
      report({ rig_number: 2, position: null, laps_completed: 1, lap_dist_pct: 0.9 }),
      report({ rig_number: 3, position: 1 }),
      report({ rig_number: 4, position: null, laps_completed: null, lap_dist_pct: null }),
    ]);
    expect(race.rows.map((r) => r.rigNumber)).toEqual([3, 2, 1, 4]);
  });

  it("returns the largest session as the race and counts the rigs left out", () => {
    const race = liveRace([
      report({ rig_number: 1, session_unique_id: 500, position: 1 }),
      report({ rig_number: 2, session_unique_id: 500, position: 2 }),
      report({ rig_number: 3, session_unique_id: 900, position: 1 }),
    ]);
    expect(race.session).toMatchObject({ sessionUniqueId: 500, sessionNum: 2 });
    expect(race.rows.map((r) => r.rigNumber)).toEqual([1, 2]);
    expect(race.otherRigs).toBe(1);
  });

  it("keeps a rig still in practice out of the race under the same server session", () => {
    const race = liveRace([
      report({ rig_number: 1, session_num: 2, position: 1 }),
      report({ rig_number: 2, session_num: 2, position: 2 }),
      report({ rig_number: 3, session_num: 0, session_type: "Practice", position: 1 }),
    ]);
    expect(race.rows.map((r) => r.rigNumber)).toEqual([1, 2]);
    expect(race.otherRigs).toBe(1);
  });

  it("breaks a tie between sessions by the one heard from most recently, whatever the row order", () => {
    const rows = [
      report({ rig_number: 1, session_unique_id: 500, age_s: 9 }),
      report({ rig_number: 2, session_unique_id: 900, age_s: 2 }),
    ];
    expect(liveRace(rows).session?.sessionUniqueId).toBe(900);
    expect(liveRace([...rows].reverse()).session?.sessionUniqueId).toBe(900);
  });

  it("takes the session's state and what remains from the leader's report", () => {
    const race = liveRace([
      report({ rig_number: 1, position: 2, session_state: 4, session_time_remain_s: 610 }),
      report({
        rig_number: 2,
        position: 1,
        session_state: 5,
        session_flags: 1,
        session_time_remain_s: 600,
        session_laps_remain: 0,
      }),
    ]);
    expect(race.session).toEqual({
      sessionUniqueId: 500,
      sessionNum: 2,
      sessionType: "Race",
      isRace: true,
      sessionState: 5,
      sessionFlags: 1,
      timeRemainS: 600,
      lapsRemain: 0,
    });
  });

  it("derives each interval from the gaps to the leader, never below zero", () => {
    const race = liveRace([
      report({ rig_number: 1, position: 1, gap_to_leader_s: 0 }),
      report({ rig_number: 2, position: 2, gap_to_leader_s: 1.5 }),
      report({ rig_number: 3, position: 3, gap_to_leader_s: 4 }),
      // Sampled a moment before rig 3, so its gap reads smaller.
      report({ rig_number: 4, position: 4, gap_to_leader_s: 3.9 }),
      report({ rig_number: 5, position: 5, gap_to_leader_s: null }),
      report({ rig_number: 6, position: 6, gap_to_leader_s: 9 }),
    ]);
    expect(race.rows.map((r) => [r.gapToLeaderS, r.intervalS])).toEqual([
      [0, null],
      [1.5, 1.5],
      [4, 2.5],
      [3.9, 0],
      [null, null],
      [9, null],
    ]);
  });

  it("rounds an interval to the millisecond rather than passing float noise to the board", () => {
    // 5.292 - 1.564 is 3.7279999999999998 in floating point.
    const race = liveRace([
      report({ rig_number: 1, position: 1, gap_to_leader_s: 1.564 }),
      report({ rig_number: 2, position: 2, gap_to_leader_s: 5.292 }),
    ]);
    expect(race.rows[1]!.intervalS).toBe(3.728);
  });

  it("shows no gap outside a race, where iRacing's variable is a lap time", () => {
    const race = liveRace([
      report({ rig_number: 1, position: 1, session_type: "Open Qualify", gap_to_leader_s: 137.9 }),
      report({ rig_number: 2, position: 2, session_type: "Open Qualify", gap_to_leader_s: 138.4 }),
    ]);
    expect(race.session?.isRace).toBe(false);
    expect(race.rows.map((r) => [r.gapToLeaderS, r.intervalS])).toEqual([
      [null, null],
      [null, null],
    ]);
  });

  it("marks a rig stale once it has been silent past the threshold", () => {
    const race = liveRace([
      report({ rig_number: 1, position: 1, age_s: RACE_STALE_AFTER_S }),
      report({ rig_number: 2, position: 2, age_s: RACE_STALE_AFTER_S + 0.1 }),
    ]);
    expect(race.rows.map((r) => r.stale)).toEqual([false, true]);
  });

  it("keeps a silent car in its place, but behind the car now reporting that place", () => {
    const race = liveRace([
      report({ rig_number: 1, position: 1, gap_to_leader_s: 0, age_s: 30, session_time_remain_s: 700 }),
      report({ rig_number: 2, position: 1, gap_to_leader_s: 0, session_time_remain_s: 670 }),
      report({ rig_number: 3, position: 2, gap_to_leader_s: 1.2 }),
      report({ rig_number: 4, position: 3, gap_to_leader_s: 2, age_s: 20 }),
      report({ rig_number: 5, position: 4, gap_to_leader_s: 3.5 }),
    ]);
    expect(race.rows.map((r) => [r.rigNumber, r.stale, r.intervalS])).toEqual([
      [2, false, null],
      // Measured to nobody: the car above it has stopped reporting.
      [1, true, null],
      [3, false, null],
      [4, true, null],
      [5, false, null],
    ]);
    // The session clock is the live leader's, not the silent car's frozen one.
    expect(race.session?.timeRemainS).toBe(670);
  });

  it("still measures between cars that are both reporting", () => {
    const race = liveRace([
      report({ rig_number: 1, position: 1, gap_to_leader_s: 0 }),
      report({ rig_number: 2, position: 2, gap_to_leader_s: 1.2 }),
      report({ rig_number: 3, position: 3, gap_to_leader_s: 2, age_s: 20 }),
    ]);
    expect(race.rows.map((r) => r.intervalS)).toEqual([null, 1.2, null]);
  });

  it("takes the session from the first row when every car has gone quiet", () => {
    const race = liveRace([
      report({ rig_number: 1, position: 2, age_s: 40, session_time_remain_s: 600 }),
      report({ rig_number: 2, position: 1, age_s: 50, session_time_remain_s: 590 }),
    ]);
    expect(race.session?.timeRemainS).toBe(590);
  });

  it("names a rig with nobody checked in by its number alone", () => {
    const race = liveRace([
      report({ rig_number: 4, position: 1, driver_id: "d1", driver_name: "Mike" }),
      report({ rig_number: 7, position: 2 }),
    ]);
    expect(race.rows.map((r) => [r.rigNumber, r.driverName])).toEqual([
      [4, "Mike"],
      [7, null],
    ]);
  });
});
