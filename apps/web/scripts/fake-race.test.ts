import { describe, expect, it } from "vitest";
import { raceStatusEvent, type RaceStatusEvent } from "../src/lib/events";
import { fakeRaceProblem, fakeRaceStatus, type FakeRace } from "./fake-race";

/**
 * What `fake-rig.ts --race` promises a demo and the soak: rigs that never talk
 * to each other agree on one race, cars really do pass each other, the
 * reported position trails a pass until the line as iRacing's does, and every
 * report is one the route accepts.
 */

const RACE: FakeRace = {
  field: 20,
  lapMs: 138_500,
  startMs: Date.parse("2026-10-07T19:00:00Z"),
  raceMs: 20 * 60_000,
  sessionBase: 400_000,
};

function field(nowMs: number, race = RACE) {
  return Array.from({ length: race.field }, (_, car) => fakeRaceStatus(race, car, nowMs));
}

/** How far round a car is, the order the feed puts a race in. */
function progress(status: RaceStatusEvent): number {
  return (status.lapsCompleted ?? -1) + status.lapDistPct!;
}

describe("fakeRaceStatus", () => {
  it("moves a car's reported position only when it crosses the line, and keeps it in the field", () => {
    let previous = field(RACE.startMs);
    for (let s = 2.5; s < RACE.raceMs / 1000; s += 2.5) {
      const now = field(RACE.startMs + s * 1000);
      for (const [car, status] of now.entries()) {
        expect(status.position).toBeGreaterThanOrEqual(1);
        expect(status.position).toBeLessThanOrEqual(RACE.field);
        if (status.lapsCompleted === previous[car]!.lapsCompleted) {
          expect(status.position).toBe(previous[car]!.position);
        }
      }
      previous = now;
    }
  });

  it("has two cars trade places on track within the first minute", () => {
    const order = (s: number) => {
      const [first, second] = field(RACE.startMs + s * 1000);
      return progress(first!) > progress(second!);
    };
    const seen = new Set<boolean>();
    for (let s = 0; s < 60; s += 2.5) seen.add(order(s));
    expect(seen).toEqual(new Set([true, false]));
  });

  it("has a car ahead on track still report the position behind until the line, then take it", () => {
    let trailing = false;
    const ahead = new Set<boolean>();
    for (let s = 0; s < RACE.raceMs / 1000; s += 2.5) {
      const [first, second] = field(RACE.startMs + s * 1000);
      if ((progress(first!) > progress(second!)) !== first!.position! < second!.position!) {
        trailing = true;
      }
      ahead.add(first!.position! < second!.position!);
    }
    expect(trailing).toBe(true);
    expect(ahead).toEqual(new Set([true, false]));
  });

  it("only ever builds reports the route accepts, across a whole race", () => {
    for (let s = 0; s < RACE.raceMs / 1000; s += 2.5) {
      for (const status of field(RACE.startMs + s * 1000)) {
        const parsed = raceStatusEvent.safeParse(status);
        expect(parsed.error?.issues ?? []).toEqual([]);
      }
    }
  });

  it("measures a gap of zero for the leader and a lap time for each completed lap", () => {
    const later = field(RACE.startMs + 10 * 60_000);
    const leader = later.reduce((a, b) => (progress(b) > progress(a) ? b : a));
    expect(leader.gapToLeaderS).toBe(0);
    for (const car of later) {
      expect(car.lastLapMs).toBeGreaterThan(RACE.lapMs - 5_000);
      expect(car.lastLapMs).toBeLessThan(RACE.lapMs + 5_000);
      expect(car.bestLapMs).toBeLessThanOrEqual(car.lastLapMs!);
    }
  });

  it("shows the chequered flag at the end, then starts a new session", () => {
    const end = fakeRaceStatus(RACE, 0, RACE.startMs + RACE.raceMs - 30_000);
    expect(end).toMatchObject({ sessionState: 5, sessionUniqueId: 400_000 });

    const next = fakeRaceStatus(RACE, 0, RACE.startMs + RACE.raceMs + 1_000);
    expect(next).toMatchObject({ sessionState: 4, sessionUniqueId: 400_001 });
  });
});

describe("fakeRaceProblem", () => {
  it.each([
    [{ field: 0 }, 0, /--field/],
    [{ field: 65 }, 0, /--field/],
    [{}, 20, /--car/],
    [{}, -1, /--car/],
    [{ lapMs: 600_000 }, 0, /--pace/],
    [{ raceMs: 30_000 }, 0, /--race-minutes/],
  ])("refuses %o for car %d", (change, car, message) => {
    expect(fakeRaceProblem({ ...RACE, ...change }, car)).toMatch(message);
  });

  it("accepts the defaults", () => {
    expect(fakeRaceProblem(RACE, 19)).toBeNull();
  });
});
