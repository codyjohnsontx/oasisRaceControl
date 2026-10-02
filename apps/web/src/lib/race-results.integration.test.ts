import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, expect, it } from "vitest";
import { POST as raceStatus } from "@/app/api/agent/race-status/route";
import { SESSION_STATE, type RaceStatusEvent } from "@/lib/events";
import { repeatedPlaces } from "@/lib/league";
import { closeLeagueRound, getRoundField } from "@/lib/league-queries";
import {
  computeSeasonStandings,
  PARTICIPATION_POINTS,
  POINTS_BY_POSITION,
  QUALIFYING_BONUS_POINTS,
} from "@/lib/league-scoring";
import { getRaceReview, saveRaceResult } from "@/lib/race-results";
import {
  closeTestDb,
  describeDb,
  openAssignment,
  openLeagueRound,
  resetDb,
  seedDriver,
  seedRig,
  testDb,
  type SeededRig,
} from "@/test/db";

/**
 * League night's race result against real Postgres, from a rig's race report
 * to the points: the flag capture through the real race-status route, the
 * close sweep, staff correction, and the round's placing and scoring through
 * the same query /league and the wall read. Scoring rules alone are unit-tested
 * in league-scoring.test.ts; this is what only the database can show.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

const COMBO = { trackName: "Spa-Francorchamps", trackConfig: "Grand Prix", carName: "Porsche 911 GT3 R" };
const LEAGUE_RACE = { sessionUniqueId: 81_234_567, sessionNum: 2 };

const REPORT: RaceStatusEvent = {
  sampledAt: new Date().toISOString(),
  ...LEAGUE_RACE,
  sessionType: "Race",
  sessionState: SESSION_STATE.racing,
  sessionFlags: 0,
  sessionTimeRemainS: 600,
  sessionLapsRemain: null,
  carIdx: 0,
  position: 1,
  classPosition: 1,
  lap: 10,
  lapsCompleted: 9,
  lapDistPct: 0.5,
  gapToLeaderS: 0,
  lastLapMs: 138_000,
  bestLapMs: 137_000,
  onPitRoad: false,
  incidents: 0,
};

type Seat = { rig: SeededRig; driverId: string; assignmentId: string; name: string };

let rigNumber = 0;

/** A driver checked in on a rig of their own. */
async function seat(name: string): Promise<Seat> {
  const rig = await seedRig(++rigNumber);
  const driver = await seedDriver(name);
  const assignmentId = await openAssignment(rig.id, driver.id);
  return { rig, driverId: driver.id, assignmentId, name };
}

let sampleClock = Date.now();

/** One race report from a rig, each sampled after the last. */
async function report(rig: SeededRig, change: Partial<RaceStatusEvent>): Promise<void> {
  sampleClock += 1000;
  const res = await raceStatus(
    new Request("http://localhost/api/agent/race-status", {
      method: "POST",
      headers: { authorization: `Bearer ${rig.agentToken}` },
      body: JSON.stringify({ ...REPORT, sampledAt: new Date(sampleClock).toISOString(), ...change }),
    }),
  );
  expect(res.status).toBe(200);
}

/** Each rig reporting the league race under green, as every rig does long before the flag. */
async function racing(...seats: Seat[]): Promise<void> {
  for (const [i, s] of seats.entries()) await report(s.rig, { position: i + 1 });
}

const SOLO_RACE = { sessionUniqueId: 99_000_001, sessionNum: 0 };

const atFlag = (position: number, lapsCompleted = 12) => ({
  sessionState: SESSION_STATE.checkered,
  position,
  lapsCompleted,
});

let eventSeq = 0;

/** A valid lap on the round's combo, `minutesAgo` before now. */
async function lap(seat: Seat, lapTimeMs: number, minutesAgo: number): Promise<void> {
  await testDb().query(
    `insert into laps (
       event_id, rig_id, rig_assignment_id, driver_id, track_name, track_config,
       car_name, lap_time_ms, incident_delta, is_valid, invalid_reason, completed_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, 0, true, null,
               now() - make_interval(mins => $9))`,
    [
      `race-results-${++eventSeq}`,
      seat.rig.id,
      seat.assignmentId,
      seat.driverId,
      COMBO.trackName,
      COMBO.trackConfig,
      COMBO.carName,
      lapTimeMs,
      minutesAgo,
    ],
  );
}

/** Moves a race's start back, so laps can be driven on either side of it. */
async function raceBeganMinutesAgo(minutes: number, race = LEAGUE_RACE): Promise<void> {
  await testDb().query(
    `update league_race_starts set started_at = now() - make_interval(mins => $1)
     where session_unique_id = $2 and session_num = $3`,
    [minutes, race.sessionUniqueId, race.sessionNum],
  );
}

/** The round's placing, as /league shows it: name, position, qualifying, points. */
async function placing(roundId: string) {
  const field = await getRoundField(roundId);
  const points = new Map(
    computeSeasonStandings(field).map((standing) => [standing.driver_id, standing.points]),
  );
  return field.map((row) => ({
    name: row.display_name,
    position: row.position,
    qualifying: row.qualifying_position,
    points: points.get(row.driver_id),
  }));
}

describeDb("league night's race result against real Postgres", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("scores the finishing order at the flag plus the fastest qualifying lap", async () => {
    const roundId = await openLeagueRound(COMBO);
    const [ana, ben, cal] = [await seat("Ana"), await seat("Ben"), await seat("Cal")];
    await lap(ana, 90_000, 40);
    await lap(ben, 91_000, 40);
    await lap(cal, 92_000, 40);

    // Gridding and racing: the race is heard, nothing is placed yet.
    await racing(ana, ben, cal);
    expect((await getRoundField(roundId)).every((row) => !row.raced)).toBe(true);
    await raceBeganMinutesAgo(20);
    // Cal's fastest lap of the night is a race lap: it is no qualifying lap.
    await lap(cal, 85_000, 10);

    await report(ben.rig, atFlag(1));
    await report(ana.rig, atFlag(2));
    await report(cal.rig, atFlag(3));

    expect(await placing(roundId)).toEqual([
      { name: "Ben", position: 1, qualifying: 2, points: POINTS_BY_POSITION[0] },
      {
        name: "Ana",
        position: 2,
        qualifying: 1,
        points: POINTS_BY_POSITION[1] + QUALIFYING_BONUS_POINTS,
      },
      { name: "Cal", position: 3, qualifying: 3, points: POINTS_BY_POSITION[2] },
    ]);
    const field = await getRoundField(roundId);
    expect(field.find((row) => row.display_name === "Cal")).toMatchObject({
      raced: true,
      best_lap_ms: 85_000,
      qualifying_lap_ms: 92_000,
      finish_source: "flag",
    });
  });

  it("settles a place as the car crosses the line, never from a report sampled earlier", async () => {
    const roundId = await openLeagueRound(COMBO);
    const [ana, ben] = [await seat("Ana"), await seat("Ben")];
    await racing(ana, ben);

    await report(ana.rig, atFlag(3, 11));
    await report(ana.rig, { ...atFlag(2, 12), sessionState: SESSION_STATE.coolDown });
    // A request abandoned on a timeout, landing after its successor.
    await report(ana.rig, { ...atFlag(5, 11), sampledAt: new Date(sampleClock - 60_000).toISOString() });

    const review = await getRaceReview(roundId);
    expect(review.entries).toMatchObject([
      { display_name: "Ana", finish_position: 2, source: "flag", rig_number: ana.rig.rigNumber, laps_completed: 12 },
    ]);
  });

  it("does not hand a rig's place to a driver who signs in during cool-down", async () => {
    const roundId = await openLeagueRound(COMBO);
    const [ana, ben] = [await seat("Ana"), await seat("Ben")];
    await racing(ana, ben);
    await report(ana.rig, atFlag(1));

    await testDb().query(
      "update rig_assignments set ended_at = now(), end_reason = 'driver_ended' where id = $1",
      [ana.assignmentId],
    );
    const dee = await seedDriver("Dee");
    await openAssignment(ana.rig.id, dee.id);
    await report(ana.rig, { ...atFlag(1), sessionState: SESSION_STATE.coolDown });

    expect((await getRaceReview(roundId)).entries.map((entry) => entry.display_name)).toEqual(["Ana"]);
  });

  it("keeps the league race when a walk-in's solo race on a spare rig finishes later", async () => {
    const roundId = await openLeagueRound(COMBO);
    const [ana, ben] = [await seat("Ana"), await seat("Ben")];
    const walkIn = await seat("Walk-in");
    await racing(ana, ben);
    await report(ana.rig, atFlag(1));
    await report(ben.rig, atFlag(2));

    await report(walkIn.rig, { ...atFlag(1), ...SOLO_RACE });

    expect((await placing(roundId)).map((row) => [row.name, row.position])).toEqual([
      ["Ana", 1],
      ["Ben", 2],
    ]);
  });

  it("never takes a walk-in's solo race that finishes first for the round's race", async () => {
    const roundId = await openLeagueRound(COMBO);
    const [ana, ben] = [await seat("Ana"), await seat("Ben")];
    const walkIn = await seat("Walk-in");
    await lap(ana, 91_000, 40);
    await lap(ben, 90_000, 40);

    await report(walkIn.rig, { ...SOLO_RACE, position: 1 });
    await report(walkIn.rig, { ...atFlag(1), ...SOLO_RACE });
    await raceBeganMinutesAgo(60, SOLO_RACE);

    // The solo race is no race of the round: nothing is placed, nothing heard.
    expect((await getRoundField(roundId)).every((row) => !row.raced)).toBe(true);
    expect(await getRaceReview(roundId)).toMatchObject({ raceHeard: false, entries: [] });

    await racing(ana, ben);
    await raceBeganMinutesAgo(20);
    await report(ben.rig, atFlag(1));
    await report(ana.rig, atFlag(2));

    // Qualifying ran until the league race began, not the solo race.
    expect(await placing(roundId)).toEqual([
      {
        name: "Ben",
        position: 1,
        qualifying: 1,
        points: POINTS_BY_POSITION[0] + QUALIFYING_BONUS_POINTS,
      },
      { name: "Ana", position: 2, qualifying: 2, points: POINTS_BY_POSITION[1] },
    ]);
  });

  it("closing mid-race sweeps the league race, not a solo race that already took the flag", async () => {
    const roundId = await openLeagueRound(COMBO);
    const [ana, ben] = [await seat("Ana"), await seat("Ben")];
    const walkIn = await seat("Walk-in");
    await report(walkIn.rig, { ...SOLO_RACE, position: 1 });
    await report(walkIn.rig, { ...atFlag(1), ...SOLO_RACE });
    await report(ana.rig, { position: 2 });
    await report(ben.rig, { position: 1 });

    expect((await closeLeagueRound(roundId))?.racePlacesSwept).toBe(2);
    expect((await placing(roundId)).map((row) => [row.name, row.position])).toEqual([
      ["Ben", 1],
      ["Ana", 2],
    ]);
  });

  it("closing mid-race records the running order, and a car missing at the flag goes behind every car seen there", async () => {
    // A race closed before the flag.
    const early = await openLeagueRound(COMBO);
    const [ana, ben] = [await seat("Ana"), await seat("Ben")];
    await report(ana.rig, { position: 2 });
    await report(ben.rig, { position: 1 });
    expect((await closeLeagueRound(early))?.racePlacesSwept).toBe(2);
    expect((await placing(early)).map((row) => [row.name, row.position])).toEqual([
      ["Ben", 1],
      ["Ana", 2],
    ]);
    expect((await getRaceReview(early)).entries.map((entry) => entry.source)).toEqual([
      "close",
      "close",
    ]);
  });

  it("puts a car that stopped reporting before the flag after the cars that finished", async () => {
    const roundId = await openLeagueRound(COMBO);
    const [ana, ben, cal] = [await seat("Ana"), await seat("Ben"), await seat("Cal")];
    // Ben was leading when his rig went quiet on lap 5; Ana won and Cal was
    // second at the flag. Ben's last place outranks Cal's, so only the flag
    // coming first puts him behind both.
    await report(ben.rig, { position: 1, lapsCompleted: 5 });
    await report(ana.rig, atFlag(1));
    await report(cal.rig, atFlag(2));

    const review = await getRaceReview(roundId);
    expect(review.notInRace).toEqual([]);
    expect(review.entries.map((entry) => entry.display_name)).toEqual(["Ana", "Cal"]);

    await closeLeagueRound(roundId);
    expect(await placing(roundId)).toMatchObject([
      { name: "Ana", position: 1, points: POINTS_BY_POSITION[0] },
      { name: "Cal", position: 2, points: POINTS_BY_POSITION[1] },
      { name: "Ben", position: 3, points: POINTS_BY_POSITION[2] },
    ]);
  });

  it("places two cars reporting one place by laps completed, and shows staff the repeat", async () => {
    const roundId = await openLeagueRound(COMBO);
    const [ana, ben] = [await seat("Ana"), await seat("Ben")];
    await racing(ana, ben);
    await report(ana.rig, atFlag(1, 9));
    await report(ben.rig, atFlag(1, 10));

    expect((await placing(roundId)).map((row) => [row.name, row.position])).toEqual([
      ["Ben", 1],
      ["Ana", 2],
    ]);
    expect([...repeatedPlaces((await getRaceReview(roundId)).entries)]).toEqual([1]);
  });

  it("lets staff correct the order and mark a DNF, then freezes the round against capture", async () => {
    const roundId = await openLeagueRound(COMBO);
    const [ana, ben, cal] = [await seat("Ana"), await seat("Ben"), await seat("Cal")];
    const dee = await seat("Dee");
    // Signed in on a rig in the race by mistake; staff take her out of it.
    const eve = await seat("Eve");
    await lap(dee, 89_000, 40); // qualified fastest, never raced
    await lap(ana, 90_000, 40);
    await racing(ana, ben, cal, eve);
    await report(ana.rig, atFlag(1));
    await report(ben.rig, atFlag(2));
    await report(cal.rig, atFlag(3));
    await report(eve.rig, atFlag(4));
    await raceBeganMinutesAgo(20);

    const before = await getRaceReview(roundId);
    expect(before).toMatchObject({ raceHeard: true, confirmed: false });
    // Dee drove only in qualifying: listed, not silently dropped.
    expect(before.notInRace.map((driver) => driver.display_name)).toEqual(["Dee"]);

    // Ana was penalised behind Cal; Ben retired.
    expect(await saveRaceResult(roundId, [cal.driverId, ana.driverId], [ben.driverId])).toEqual({
      status: "saved",
    });

    // The rigs keep reporting through cool-down, and the round closes.
    await report(ben.rig, { ...atFlag(1), sessionState: SESSION_STATE.coolDown });
    await report(eve.rig, { ...atFlag(4), sessionState: SESSION_STATE.coolDown });
    expect((await closeLeagueRound(roundId))?.racePlacesSwept).toBe(0);

    expect(await placing(roundId)).toEqual([
      { name: "Cal", position: 1, qualifying: null, points: POINTS_BY_POSITION[0] },
      { name: "Ana", position: 2, qualifying: 2, points: POINTS_BY_POSITION[1] },
      {
        name: "Dee",
        position: null,
        qualifying: 1,
        points: PARTICIPATION_POINTS + QUALIFYING_BONUS_POINTS,
      },
      { name: "Ben", position: null, qualifying: null, points: PARTICIPATION_POINTS },
    ]);
    const review = await getRaceReview(roundId);
    expect(review.confirmed).toBe(true);
    // A correction keeps where each captured place came from.
    expect(review.entries.find((entry) => entry.display_name === "Cal")?.rig_number).toBe(
      cal.rig.rigNumber,
    );
    expect((await getRoundField(roundId)).find((row) => row.display_name === "Ben")).toMatchObject({
      finish_source: "staff",
      position: null,
    });
  });

  it("refuses a correction naming a driver outside the round, or on a closed round", async () => {
    const roundId = await openLeagueRound(COMBO);
    const [ana, ben] = [await seat("Ana"), await seat("Ben")];
    await racing(ana, ben);
    await report(ana.rig, atFlag(1));
    const stranger = await seedDriver("Stranger");

    expect(await saveRaceResult(roundId, [ana.driverId, stranger.id], [])).toEqual({
      status: "unknown_driver",
    });
    await closeLeagueRound(roundId);
    expect(await saveRaceResult(roundId, [ana.driverId], [])).toEqual({ status: "not_open" });
  });

  it("places a round with no race result by fastest lap, exactly as before, with no bonus", async () => {
    const roundId = await openLeagueRound(COMBO);
    const [ana, ben, cal] = [await seat("Ana"), await seat("Ben"), await seat("Cal")];
    await lap(ben, 90_000, 30);
    await lap(ana, 91_000, 30);
    await lap(cal, 95_000, 30);
    await testDb().query("update laps set is_valid = false, invalid_reason = 'OFF_TRACK' where driver_id = $1", [
      cal.driverId,
    ]);
    // A practice session is no race.
    await report(ana.rig, { ...atFlag(1), sessionType: "Practice" });

    expect((await getRoundField(roundId)).every((row) => !row.raced)).toBe(true);
    expect(await placing(roundId)).toEqual([
      { name: "Ben", position: 1, qualifying: 1, points: POINTS_BY_POSITION[0] },
      { name: "Ana", position: 2, qualifying: 2, points: POINTS_BY_POSITION[1] },
      { name: "Cal", position: null, qualifying: null, points: PARTICIPATION_POINTS },
    ]);
    expect(await getRaceReview(roundId)).toMatchObject({ raceHeard: false, entries: [] });
  });

  it("records nothing while no round is open", async () => {
    const ana = await seat("Ana");
    await report(ana.rig, atFlag(1));

    const { rows } = await testDb().query(
      "select (select count(*) from league_race_results)::int as results, (select count(*) from league_race_starts)::int as starts",
    );
    expect(rows).toEqual([{ results: 0, starts: 0 }]);
  });

  it("passes the read-only verify the owner runs after hand-applying 0009", async () => {
    const verify = readFileSync(join(REPO_ROOT, "db", "verify", "0009_race_results.sql"), "utf8");
    const client = await testDb().connect();
    try {
      await client.query(
        `create temporary table schema_migrations (version text primary key);
         insert into schema_migrations values ('0009_race_results.sql')`,
      );
      const { rows } = await client.query<{ check_name: string; ok: boolean }>(verify);

      expect(rows).toHaveLength(7);
      expect(rows.filter((check) => !check.ok)).toEqual([]);
    } finally {
      await client.query("drop table if exists pg_temp.schema_migrations");
      client.release();
    }
  });
});
