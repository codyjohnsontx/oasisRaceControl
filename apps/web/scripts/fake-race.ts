/**
 * The race `fake-rig.ts --race` drives: a whole field simulated from the wall
 * clock alone, so every fake rig computes the SAME race without talking to the
 * others and reports only its own car - which is how the real agents behave in
 * one hosted iRacing session. Start three fake rigs with `--car 0`, `--car 1`
 * and `--car 2` and the live feed shows one race whose order changes as cars
 * pass each other.
 *
 * Pure and import-free of anything that runs, so scripts/fake-race.test.ts can
 * pin what the demo promises: one position per car, and cars that actually
 * trade places.
 *
 * Each car's distance is the pace's steady progress, minus its grid slot, plus
 * an oscillation phase-shifted from its neighbour's by a quarter turn. The
 * oscillation is larger than the gap between grid slots, so neighbours swap
 * back and forth every PERIOD_S or so, and it is small enough against the pace
 * that no car ever runs backwards.
 */

import { SESSION_STATE, type RaceStatusEvent } from "../src/lib/events";

export type FakeRace = {
  /** Cars in the field, all of them simulated whether or not a rig reports them. */
  field: number;
  /** One lap at steady pace, in ms. */
  lapMs: number;
  /** When race 0 started; races follow back to back from here. */
  startMs: number;
  /** How long each race lasts; the next one is a new iRacing session. */
  raceMs: number;
  /** SessionUniqueID of race 0; each later race is one more. */
  sessionBase: number;
};

/** Grid slots are this many laps apart. */
const GRID_GAP_LAPS = 0.01;
/** Larger than one grid gap over the square root of two, so neighbours swap. */
const SWING_LAPS = 0.012;
const PERIOD_S = 40;
/** The last minute of each race is shown under the chequered flag. */
const CHECKERED_S = 60;

const FLAG_CHECKERED = 0x0001;
const FLAG_GREEN = 0x0004;

/** Refuses a race this model cannot drive honestly, before any report is built. */
export function fakeRaceProblem(race: FakeRace, car: number): string | null {
  if (!Number.isInteger(race.field) || race.field < 1 || race.field > 64) {
    return "--field must be a whole number from 1 to 64";
  }
  if (!Number.isInteger(car) || car < 0 || car >= race.field) {
    return `--car must be a whole number from 0 to ${race.field - 1}`;
  }
  // Steady progress must outrun the oscillation, or a car would reverse.
  const slowestLapS = PERIOD_S / (SWING_LAPS * 2 * Math.PI);
  if (!(race.lapMs >= 30_000 && race.lapMs / 1000 < slowestLapS)) {
    return `--pace must be from 30000 to ${Math.floor(slowestLapS * 1000) - 1} ms in race mode`;
  }
  if (!(race.raceMs > CHECKERED_S * 1000) || !Number.isFinite(race.startMs)) {
    return "--race-minutes must be over one minute and --race-start a valid time";
  }
  return null;
}

/** Laps covered by `car`, `t` seconds into the race. Negative on the grid. */
function distance(race: FakeRace, car: number, t: number): number {
  return (
    t / (race.lapMs / 1000) -
    GRID_GAP_LAPS * car +
    SWING_LAPS * Math.sin((2 * Math.PI * t) / PERIOD_S + (car * Math.PI) / 2)
  );
}

/** Seconds into the race at which `car` reached `laps`; 0 if it started past it. */
function timeAt(race: FakeRace, car: number, laps: number): number {
  let lo = 0;
  let hi = race.raceMs / 1000;
  if (distance(race, car, lo) >= laps) return 0;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (distance(race, car, mid) < laps) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** `car`'s race status at `nowMs`, as a real agent would report it. */
export function fakeRaceStatus(race: FakeRace, car: number, nowMs: number): RaceStatusEvent {
  const elapsedMs = Math.max(0, nowMs - race.startMs);
  const cycle = Math.floor(elapsedMs / race.raceMs);
  const t = (elapsedMs - cycle * race.raceMs) / 1000;
  const raceS = race.raceMs / 1000;

  const distances = Array.from({ length: race.field }, (_, i) => distance(race, i, t));
  const mine = distances[car]!;
  const leader = Math.max(...distances);
  const position = 1 + distances.filter((d, i) => d > mine || (d === mine && i < car)).length;

  const completed = Math.floor(mine);
  const lapTimes: number[] = [];
  for (let k = 1; k <= completed; k++) {
    lapTimes.push(Math.round((timeAt(race, car, k) - timeAt(race, car, k - 1)) * 1000));
  }
  const lap = Math.max(0, completed + 1);
  const pct = mine - completed;
  const checkered = raceS - t <= CHECKERED_S;

  return {
    sampledAt: new Date(nowMs).toISOString(),
    sessionUniqueId: race.sessionBase + cycle,
    sessionNum: 2,
    sessionType: "Race",
    sessionState: checkered ? SESSION_STATE.checkered : SESSION_STATE.racing,
    sessionFlags: checkered ? FLAG_CHECKERED : FLAG_GREEN,
    sessionTimeRemainS: Math.round((raceS - t) * 10) / 10,
    sessionLapsRemain: null,
    carIdx: car,
    position,
    classPosition: position,
    lap,
    lapsCompleted: completed >= 0 ? completed : null,
    lapDistPct: Math.round(pct * 10_000) / 10_000,
    gapToLeaderS: Math.round((leader - mine) * (race.lapMs / 1000) * 1000) / 1000,
    lastLapMs: lapTimes.at(-1) ?? null,
    bestLapMs: lapTimes.length > 0 ? Math.min(...lapTimes) : null,
    // Each car takes a trip down pit lane every sixth lap, so the board's pit
    // marker has something to show.
    onPitRoad: lap > 1 && lap % 6 === car % 6 && pct > 0.9,
    incidents: Math.floor(t / (300 + 37 * car)) * 2,
  };
}
