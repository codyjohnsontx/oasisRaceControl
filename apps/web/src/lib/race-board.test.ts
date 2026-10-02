import { describe, expect, it } from "vitest";
import { SESSION_STATE } from "./events";
import type { LiveRace } from "./race-live";
import { liveRaceFeed, liveRaceRow } from "../test/live-race-fixture";
import {
  INITIAL_RACE_BOARD,
  RACE_FINISH_HOLD_MS,
  RACE_MIN_RIGS,
  applyRaceFeed,
  applyRaceFeedFailure,
  formatRaceGap,
  isLiveRace,
  placeChanges,
  remainingLabel,
  rowName,
  sessionStateLabel,
  type RaceBoardState,
} from "./race-board";

/**
 * When the race screen replaces the standings and when it gives them back.
 * One rule set for the wall and the phone, so it is pinned here once.
 */

const row = liveRaceRow;
const feed = liveRaceFeed;

const empty: LiveRace = { session: null, rows: [], otherRigs: 0 };
const t0 = 1_700_000_000_000;

describe("isLiveRace", () => {
  it("needs a Race session with at least two rigs in it", () => {
    expect(isLiveRace(feed([row(1, 1), row(2, 2)]))).toBe(true);
    expect(isLiveRace(feed([row(1, 1)]))).toBe(false);
    expect(RACE_MIN_RIGS).toBe(2);
    expect(isLiveRace(feed([row(1, 1), row(2, 2)], { isRace: false, sessionType: "Practice" }))).toBe(
      false,
    );
    expect(isLiveRace(empty)).toBe(false);
  });
});

describe("applyRaceFeed", () => {
  it("puts a race under way on screen and takes it off when the feed has none", () => {
    const racing = applyRaceFeed(INITIAL_RACE_BOARD, feed([row(1, 1), row(2, 2)]), t0);
    expect(racing.race?.rows.map((r) => r.rigNumber)).toEqual([1, 2]);
    expect(racing.finish).toBeNull();

    const gone = applyRaceFeed(racing, empty, t0 + 5_000);
    expect(gone.race).toBeNull();
  });

  it("shows the grid and the formation lap too, not only the green", () => {
    for (const sessionState of [SESSION_STATE.getInCar, SESSION_STATE.warmup, SESSION_STATE.paradeLaps]) {
      const state = applyRaceFeed(INITIAL_RACE_BOARD, feed([row(1, 1), row(2, 2)], { sessionState }), t0);
      expect(state.race).not.toBeNull();
    }
  });

  it("holds the finishing order for the minute after the flag, then gives the screen back", () => {
    const rows = [row(1, 1), row(2, 2)];
    const racing = applyRaceFeed(INITIAL_RACE_BOARD, feed(rows), t0);
    const flag = feed(rows, { sessionState: SESSION_STATE.checkered });

    const atFlag = applyRaceFeed(racing, flag, t0 + 10_000);
    expect(atFlag.race).not.toBeNull();
    expect(atFlag.finish).toEqual({ sessionKey: "100:2", flagAt: t0 + 10_000 });

    // Still crossing the line: the order keeps updating through the hold.
    const later = feed([row(2, 1), row(1, 2)], { sessionState: SESSION_STATE.coolDown });
    const midHold = applyRaceFeed(atFlag, later, t0 + 10_000 + RACE_FINISH_HOLD_MS - 1);
    expect(midHold.race?.rows.map((r) => r.rigNumber)).toEqual([2, 1]);
    expect(midHold.finish?.flagAt).toBe(t0 + 10_000);

    // The hold is counted from the first report of the flag, not the last.
    const afterHold = applyRaceFeed(midHold, later, t0 + 10_000 + RACE_FINISH_HOLD_MS);
    expect(afterHold.race).toBeNull();
    expect(afterHold.finish?.sessionKey).toBe("100:2");
  });

  it("does not bring a finished race back while its rigs still report the flag", () => {
    const flag = feed([row(1, 1), row(2, 2)], { sessionState: SESSION_STATE.checkered });
    let state = applyRaceFeed(INITIAL_RACE_BOARD, flag, t0);
    state = applyRaceFeed(state, flag, t0 + RACE_FINISH_HOLD_MS + 1_000);
    expect(state.race).toBeNull();
    state = applyRaceFeed(state, flag, t0 + RACE_FINISH_HOLD_MS + 30_000);
    expect(state.race).toBeNull();
  });

  it("shows the next race, a new session, as soon as it starts", () => {
    const flag = feed([row(1, 1), row(2, 2)], { sessionState: SESSION_STATE.checkered });
    let state = applyRaceFeed(INITIAL_RACE_BOARD, flag, t0);
    state = applyRaceFeed(state, flag, t0 + RACE_FINISH_HOLD_MS + 1_000);
    expect(state.race).toBeNull();

    const next = feed([row(2, 1), row(1, 2)], { sessionUniqueId: 101, sessionState: SESSION_STATE.getInCar });
    state = applyRaceFeed(state, next, t0 + RACE_FINISH_HOLD_MS + 2_000);
    expect(state.race?.session?.sessionUniqueId).toBe(101);
    // The old race's flag is still remembered, so a feed that flips back to
    // it (a tie between two groups of rigs) does not replay its finish.
    expect(state.finish?.sessionKey).toBe("100:2");
  });

  it("forgets the flag when the same session goes back under green", () => {
    const rows = [row(1, 1), row(2, 2)];
    let state = applyRaceFeed(INITIAL_RACE_BOARD, feed(rows, { sessionState: SESSION_STATE.checkered }), t0);
    state = applyRaceFeed(state, feed(rows), t0 + 5_000);
    expect(state.finish).toBeNull();
    expect(state.race).not.toBeNull();
  });

  it("keeps a finished race on screen through its hold when its rigs leave the session", () => {
    const flag = feed([row(1, 1), row(2, 2)], { sessionState: SESSION_STATE.checkered });
    const atFlag = applyRaceFeed(INITIAL_RACE_BOARD, flag, t0);

    // The rigs quit to the menu: the feed has one rig, then none.
    const leaving = applyRaceFeed(atFlag, feed([row(1, 1)], { sessionState: SESSION_STATE.checkered }), t0 + 20_000);
    expect(leaving.race).toBe(atFlag.race);
    const gone = applyRaceFeed(leaving, empty, t0 + 40_000);
    expect(gone.race).toBe(atFlag.race);

    const expired = applyRaceFeed(gone, empty, t0 + RACE_FINISH_HOLD_MS);
    expect(expired.race).toBeNull();
  });

  it("takes a race under way off the screen the moment the feed loses it", () => {
    const racing = applyRaceFeed(INITIAL_RACE_BOARD, feed([row(1, 1), row(2, 2)]), t0);
    expect(applyRaceFeed(racing, feed([row(1, 1)]), t0 + 3_000).race).toBeNull();
  });
});

describe("applyRaceFeedFailure", () => {
  it("keeps the race on screen while it is younger than the feed's own drop, then clears it", () => {
    const racing = applyRaceFeed(INITIAL_RACE_BOARD, feed([row(1, 1), row(2, 2)]), t0);
    expect(applyRaceFeedFailure(racing, t0 + 59_000)).toBe(racing);
    expect(applyRaceFeedFailure(racing, t0 + 61_000).race).toBeNull();
  });

  it("is a no-op with nothing on screen", () => {
    const state: RaceBoardState = { ...INITIAL_RACE_BOARD };
    expect(applyRaceFeedFailure(state, t0 + 100_000)).toBe(state);
  });
});

describe("placeChanges", () => {
  it("names each rig that moved, with places gained positive and lost negative", () => {
    const before = feed([row(1, 1), row(2, 2), row(3, 3)]);
    const after = feed([row(2, 1), row(3, 2), row(1, 3)]);
    expect([...placeChanges(before, after)]).toEqual([
      [2, 1],
      [3, 1],
      [1, -2],
    ]);
  });

  it("has nothing to say about the first answer or a rig new to the board", () => {
    expect(placeChanges(null, feed([row(1, 1)])).size).toBe(0);
    expect(placeChanges(feed([row(1, 1)]), feed([row(1, 1), row(2, 2)])).size).toBe(0);
  });

  it("keys on the rig, not the driver, so an empty seat moves too", () => {
    const before = feed([row(7, 1, { driverName: null, driverId: null }), row(2, 2)]);
    const after = feed([row(2, 1), row(7, 2, { driverName: null, driverId: null })]);
    expect(placeChanges(before, after).get(7)).toBe(-1);
  });

  it("marks nothing when the next answer is a different session", () => {
    const finish = feed([row(1, 1), row(2, 2)], { sessionState: SESSION_STATE.checkered });
    const nextGrid = feed([row(2, 1), row(1, 2)], { sessionNum: 3 });
    expect(placeChanges(finish, nextGrid).size).toBe(0);
    const nextEvent = feed([row(2, 1), row(1, 2)], { sessionUniqueId: 101 });
    expect(placeChanges(finish, nextEvent).size).toBe(0);
  });
});

describe("the words on the screen", () => {
  it("names a rig with nobody signed in by its number", () => {
    expect(rowName(row(7, 1, { driverName: null }))).toBe("Rig 7");
    expect(rowName(row(7, 1))).toBe("Driver 7");
  });

  it("says the session's state", () => {
    expect(sessionStateLabel(SESSION_STATE.racing)).toBe("Racing");
    expect(sessionStateLabel(SESSION_STATE.checkered)).toBe("Chequered flag");
    expect(sessionStateLabel(SESSION_STATE.coolDown)).toBe("Finished");
    expect(sessionStateLabel(SESSION_STATE.paradeLaps)).toBe("Formation lap");
    expect(sessionStateLabel(SESSION_STATE.invalid)).toBe("Race");
  });

  it("says laps when the race is run to laps, time otherwise, nothing under the flag", () => {
    const racing = { sessionState: SESSION_STATE.racing, lapsRemain: 12, timeRemainS: 600 };
    expect(remainingLabel(racing)).toBe("12 laps to go");
    expect(remainingLabel({ ...racing, lapsRemain: 1 })).toBe("Final lap");
    expect(remainingLabel({ ...racing, lapsRemain: null })).toBe("10:00 to go");
    expect(remainingLabel({ ...racing, lapsRemain: null, timeRemainS: 65.4 })).toBe("1:05 to go");
    expect(remainingLabel({ ...racing, lapsRemain: null, timeRemainS: null })).toBeNull();
    expect(remainingLabel({ ...racing, sessionState: SESSION_STATE.checkered })).toBeNull();
  });

  it("prints a gap the way the lap boards do", () => {
    expect(formatRaceGap(1.234)).toBe("+1.234");
    expect(formatRaceGap(61.204)).toBe("+1:01.204");
    expect(formatRaceGap(0)).toBe("—");
    expect(formatRaceGap(null)).toBe("—");
  });
});
