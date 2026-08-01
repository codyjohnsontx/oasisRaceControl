import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { computeValidity, type FeaturedCombo } from "./validity";
import { venueToday } from "./venue";

/**
 * League night's effect on the rest of the venue day, end to end against a
 * real Postgres.
 *
 * The rules under test are SQL - v_fastest_tonight decides what "Fastest
 * Tonight" shows, v_league_round_laps decides who is in a round's field - so a
 * mocked pool would assert nothing. This builds a scratch database from
 * db/migrations, runs the real open/close/ingest path against it, and drops it
 * afterwards; no existing data is touched.
 *
 * It runs when a local Postgres is reachable (the dev container in
 * apps/web/.env.local) and skips otherwise, so it never fires at a remote
 * database by accident. Point it somewhere explicitly with TEST_DATABASE_URL.
 */
function serverUrl(): string | null {
  const explicit = process.env.TEST_DATABASE_URL;
  if (explicit) return explicit;
  const configured = process.env.DATABASE_URL;
  if (!configured) return null;
  try {
    const { hostname } = new URL(configured);
    // WHATWG URL keeps the brackets on an IPv6 host, so "[::1]" is the form
    // that actually turns up here; the bare one is accepted for good measure.
    const local =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]";
    return local ? configured : null;
  } catch {
    return null;
  }
}

const SERVER_URL = serverUrl();
const TEST_DB = `oasis_league_test_${process.pid}`;

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function migration(file: string): string {
  return readFileSync(new URL(`../../../../db/migrations/${file}`, import.meta.url), "utf8");
}

describe.skipIf(!SERVER_URL)("league round lifecycle (real Postgres)", () => {
  let dbModule: typeof import("./db");
  let league: typeof import("./league-queries");
  let admin: Client | undefined;
  const rigs: Record<string, string> = {};
  const assignments: Record<string, string> = {};
  let rigSeq = 0;
  let eventSeq = 0;

  beforeAll(async () => {
    admin = new Client({ connectionString: withDatabase(SERVER_URL!, "postgres") });
    await admin.connect();
    await admin.query(`drop database if exists ${TEST_DB} with (force)`);
    await admin.query(`create database ${TEST_DB}`);

    const testUrl = withDatabase(SERVER_URL!, TEST_DB);
    const schema = new Client({ connectionString: testUrl });
    await schema.connect();
    try {
      await schema.query(migration("0001_core_schema.sql"));
      await schema.query(migration("0002_league_night.sql"));
    } finally {
      await schema.end();
    }

    process.env.DATABASE_URL = testUrl;
    dbModule = await import("./db");
    league = await import("./league-queries");
  }, 60_000);

  afterAll(async () => {
    if (!SERVER_URL) return;
    await dbModule?.db().end();
    await admin?.query(`drop database if exists ${TEST_DB} with (force)`);
    await admin?.end();
  });

  beforeEach(async () => {
    await dbModule.query("truncate laps, leagues, featured_combos cascade");
  });

  /** A driver checked in at their own rig, the way the QR entry path leaves
   *  one - a rig holds a single open assignment, so one rig each. */
  async function driver(name: string): Promise<string> {
    const row = await dbModule.queryOne<{ id: string }>(
      "insert into drivers (display_name) values ($1) returning id",
      [name],
    );
    const rig = await dbModule.queryOne<{ id: string }>(
      "insert into rigs (rig_number, display_name) values ($1, $2) returning id",
      [++rigSeq, `Rig ${rigSeq}`],
    );
    const assignment = await dbModule.queryOne<{ id: string }>(
      "insert into rig_assignments (rig_id, driver_id) values ($1, $2) returning id",
      [rig!.id, row!.id],
    );
    rigs[row!.id] = rig!.id;
    assignments[row!.id] = assignment!.id;
    return row!.id;
  }

  /**
   * A lap arriving from a rig agent, judged exactly the way
   * api/agent/events does it: tonight's featured combo, then computeValidity.
   */
  async function ingestLap(
    driverId: string,
    lap: {
      trackName: string;
      trackConfig?: string | null;
      carName: string;
      lapTimeMs: number;
      incidentDelta?: number;
    },
  ) {
    const combo = await dbModule.queryOne<FeaturedCombo>(
      `select track_name, track_config, car_name, incident_limit
       from featured_combos where combo_date = $1`,
      [venueToday()],
    );
    const validity = computeValidity(
      {
        trackName: lap.trackName,
        trackConfig: lap.trackConfig ?? null,
        carName: lap.carName,
        incidentDelta: lap.incidentDelta ?? 0,
      },
      combo,
    );
    return dbModule.queryOne<{ id: string; is_valid: boolean; invalid_reason: string | null }>(
      `insert into laps (
         event_id, rig_id, rig_assignment_id, driver_id, track_name, track_config,
         car_name, lap_time_ms, incident_delta, is_valid, invalid_reason, completed_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       returning id, is_valid, invalid_reason`,
      [
        `evt-${++eventSeq}`,
        rigs[driverId],
        assignments[driverId],
        driverId,
        lap.trackName,
        lap.trackConfig ?? null,
        lap.carName,
        lap.lapTimeMs,
        lap.incidentDelta ?? 0,
        validity.isValid,
        validity.invalidReason,
      ],
    );
  }

  function featuredCombo() {
    return dbModule.queryOne<FeaturedCombo>(
      `select track_name, track_config, car_name, incident_limit
       from featured_combos where combo_date = $1`,
      [venueToday()],
    );
  }

  function fastestTonight(driverId: string) {
    return dbModule.query<{ track_name: string; lap_time_ms: number }>(
      "select track_name, lap_time_ms from v_fastest_tonight where driver_id = $1",
      [driverId],
    );
  }

  const WEEK_ONE = {
    name: "Week 1",
    trackName: "Spa-Francorchamps",
    trackConfig: "Grand Prix",
    carName: "Porsche 911 GT3 R",
    incidentLimit: 0,
  };

  it("frees the rest of the venue day when the venue had no featured combo", async () => {
    const racer = await driver("League Racer");
    const customer = await driver("Walk-in Customer");

    const round = await league.openLeagueRound(WEEK_ONE);
    expect(await featuredCombo()).toMatchObject({
      track_name: "Spa-Francorchamps",
      car_name: "Porsche 911 GT3 R",
    });

    // While the round is open, off-combo laps are invalid on purpose.
    const during = await ingestLap(customer, {
      trackName: "Monza",
      carName: "Mazda MX-5",
      lapTimeMs: 95_000,
    });
    expect(during).toMatchObject({ is_valid: false, invalid_reason: "WRONG_TRACK_CONFIGURATION" });

    await league.closeLeagueRound(round.id);

    // There was no row before league night, so there is no row after it.
    expect(await featuredCombo()).toBeNull();

    const after = await ingestLap(customer, {
      trackName: "Monza",
      carName: "Mazda MX-5",
      lapTimeMs: 94_000,
    });
    expect(after).toMatchObject({ is_valid: true, invalid_reason: null });
    expect(await fastestTonight(customer)).toEqual([
      { track_name: "Monza", lap_time_ms: 94_000 },
    ]);

    // The league's own laps still rank tonight as well.
    await ingestLap(racer, {
      trackName: "Spa-Francorchamps",
      trackConfig: "Grand Prix",
      carName: "Porsche 911 GT3 R",
      lapTimeMs: 130_000,
    });
    expect(await fastestTonight(racer)).toHaveLength(1);
  });

  it("puts the venue's own featured combo back", async () => {
    const customer = await driver("Featured Combo Customer");
    const featured = {
      track_name: "Nurburgring",
      track_config: null,
      car_name: "Mazda MX-5",
      incident_limit: 2,
    };
    await dbModule.query(
      `insert into featured_combos (combo_date, track_name, track_config, car_name, incident_limit)
       values ($1, $2, $3, $4, $5)`,
      [
        venueToday(),
        featured.track_name,
        featured.track_config,
        featured.car_name,
        featured.incident_limit,
      ],
    );

    const round = await league.openLeagueRound(WEEK_ONE);
    await league.closeLeagueRound(round.id);

    expect(await featuredCombo()).toEqual(featured);

    const onFeatured = await ingestLap(customer, {
      trackName: "Nurburgring",
      carName: "Mazda MX-5",
      lapTimeMs: 100_000,
    });
    expect(onFeatured).toMatchObject({ is_valid: true });
    expect(await fastestTonight(customer)).toEqual([
      { track_name: "Nurburgring", lap_time_ms: 100_000 },
    ]);

    // ...and the venue's own rule is back in force for everything else.
    const offFeatured = await ingestLap(customer, {
      trackName: "Monza",
      carName: "Mazda MX-5",
      lapTimeMs: 90_000,
    });
    expect(offFeatured).toMatchObject({ is_valid: false });
  });

  it("keeps a driver in the round's field when every lap of theirs is invalid", async () => {
    const spinner = await driver("Binned Every Lap");
    const round = await league.openLeagueRound(WEEK_ONE);

    const binned = await ingestLap(spinner, {
      trackName: WEEK_ONE.trackName,
      trackConfig: WEEK_ONE.trackConfig,
      carName: WEEK_ONE.carName,
      lapTimeMs: 132_000,
      incidentDelta: 4,
    });
    expect(binned).toMatchObject({ is_valid: false });

    const field = await league.getRoundField(round.id);
    expect(field).toHaveLength(1);
    expect(field[0]).toMatchObject({
      driver_id: spinner,
      position: null,
      lap_count: 1,
      valid_lap_count: 0,
    });
    expect(await league.countRoundDrivers(round.id)).toBe(1);
  });

  it("rolls the losing round and its season back when one is already open", async () => {
    async function counts() {
      const row = await dbModule.queryOne<{
        rounds: number;
        seasons: number;
        leagues: number;
      }>(
        `select (select count(*) from league_rounds)::int  as rounds,
                (select count(*) from league_seasons)::int as seasons,
                (select count(*) from leagues)::int        as leagues`,
      );
      return row!;
    }

    const first = await league.openLeagueRound(WEEK_ONE);
    const before = await counts();

    // one_open_round_venue_wide rejects the second round. The whole
    // transaction has to go with it - a leftover season would be picked up by
    // getActiveSeason() later and quietly split the championship in two.
    await expect(
      league.openLeagueRound({
        name: "Week 2",
        trackName: "Monza",
        trackConfig: null,
        carName: "Mazda MX-5",
        incidentLimit: 0,
      }),
    ).rejects.toMatchObject({ code: "23505" });

    expect(await counts()).toEqual(before);

    // The round that did win is untouched, and still the open one.
    const open = await league.getOpenRound();
    expect(open?.id).toBe(first.id);
    expect(await featuredCombo()).toMatchObject({ track_name: WEEK_ONE.trackName });
  });
});
