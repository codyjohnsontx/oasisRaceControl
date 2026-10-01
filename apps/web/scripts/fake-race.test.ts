import { describe, expect, it } from "vitest";
import { raceStatusEvent } from "../src/lib/events";
import { fakeRaceProblem, fakeRaceStatus, type FakeRace } from "./fake-race";

/**
 * What `fake-rig.ts --race` promises a demo and the soak: rigs that never talk
 * to each other agree on one race, every car holds a different place, cars
 * really do pass each other, and every report is one the route accepts.
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

describe("fakeRaceStatus", () => {
  it("gives every car of the field a different place at every instant", () => {
    for (let s = 0; s < RACE.raceMs / 1000; s += 7.5) {
      const positions = field(RACE.startMs + s * 1000).map((r) => r.position);
      expect([...positions].sort((a, b) => a! - b!)).toEqual(
        Array.from({ length: RACE.field }, (_, i) => i + 1),
      );
    }
  });

  it("has two cars trade places within the first minute", () => {
    const order = (s: number) => {
      const [first, second] = field(RACE.startMs + s * 1000);
      return first!.position! < second!.position!;
    };
    const seen = new Set<boolean>();
    for (let s = 0; s < 60; s += 2.5) seen.add(order(s));
    expect(seen).toEqual(new Set([true, false]));
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
    const leader = later.find((r) => r.position === 1)!;
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
