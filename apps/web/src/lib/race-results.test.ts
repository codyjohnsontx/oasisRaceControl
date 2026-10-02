import { describe, expect, it } from "vitest";
import { SESSION_STATE } from "./events";
import { repeatedPlaces } from "./league";
import { raceReportCapture } from "./race-results";

/**
 * Which race reports feed the round's result. The writes themselves are
 * pinned against Postgres in race-results.integration.test.ts.
 */
describe("raceReportCapture", () => {
  const race = { sessionType: "Race", sessionState: SESSION_STATE.racing, position: 3 };

  it("hears a race from any report of a Race session, and places a car only from the flag on", () => {
    expect(raceReportCapture({ ...race, sessionState: SESSION_STATE.getInCar })).toEqual({
      start: true,
      finish: false,
    });
    expect(raceReportCapture(race)).toEqual({ start: true, finish: false });
    expect(raceReportCapture({ ...race, sessionState: SESSION_STATE.checkered })).toEqual({
      start: true,
      finish: true,
    });
    expect(raceReportCapture({ ...race, sessionState: SESSION_STATE.coolDown })).toEqual({
      start: true,
      finish: true,
    });
  });

  it("places no car iRacing has not classified", () => {
    expect(
      raceReportCapture({ ...race, sessionState: SESSION_STATE.checkered, position: null }),
    ).toEqual({ start: true, finish: false });
  });

  it("ignores every session that is not a race, flag or not", () => {
    for (const sessionType of ["Practice", "Open Qualify", "Lone Qualify", null]) {
      expect(
        raceReportCapture({ ...race, sessionType, sessionState: SESSION_STATE.checkered }),
      ).toEqual({ start: false, finish: false });
    }
  });
});

describe("repeatedPlaces", () => {
  it("names each place recorded for more than one driver, ignoring DNFs", () => {
    const places = [1, 2, 2, null, null, 4, 4, 4].map((finish_position) => ({ finish_position }));
    expect([...repeatedPlaces(places)].sort()).toEqual([2, 4]);
    expect(repeatedPlaces([{ finish_position: 1 }, { finish_position: 2 }]).size).toBe(0);
  });
});
