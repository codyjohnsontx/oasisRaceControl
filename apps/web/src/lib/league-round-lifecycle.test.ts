import { readdirSync, readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DRIVER_LAP_CAP, lapsByDriver, ROUND_LAP_CAP } from "./league";
import { safeTestDatabaseUrl } from "../test/db-guard";
import { computeValidity, type FeaturedCombo } from "./validity";
import { venueMonthName, venueToday } from "./venue";

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
/** The scratch database this run creates, drops, and truncates. Its name
 *  carries "test" because db-guard requires that proof of disposability. */
const TEST_DB = `oasis_league_test_${process.pid}`;

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * Which server to build the scratch database on: TEST_DATABASE_URL if set,
 * otherwise a local DATABASE_URL.
 *
 * Both are validated by `safeTestDatabaseUrl` from the integration suite's
 * guard rather than by a second, looser check of this file's own - it refuses
 * managed hosts, non-local hosts, and connection parameters that could redirect
 * where pg actually connects, all before anything opens a socket. What gets
 * validated is the SCRATCH url (this file creates and drops its own database),
 * so the guard's "name must contain test" rule is satisfied by TEST_DB rather
 * than by whatever the developer's own database happens to be called.
 *
 * An explicit TEST_DATABASE_URL that fails the guard throws: it was an
 * instruction, and silently ignoring it is how a destructive suite ends up
 * believing it ran. An unusable DATABASE_URL just means "not a local box" and
 * skips, which is what keeps `npm test` green on a machine pointed at Neon.
 */
function serverUrl(): string | null {
  const explicit = process.env.TEST_DATABASE_URL;
  if (explicit) return safeTestDatabaseUrl(withDatabase(explicit, TEST_DB)) && explicit;

  const configured = process.env.DATABASE_URL;
  if (!configured) return null;
  try {
    return safeTestDatabaseUrl(withDatabase(configured, TEST_DB)) && configured;
  } catch {
    return null;
  }
}

const SERVER_URL = serverUrl();

const MIGRATIONS_DIR = new URL("../../../../db/migrations/", import.meta.url);

function migration(file: string): string {
  return readFileSync(new URL(file, MIGRATIONS_DIR), "utf8");
}

/**
 * Every migration, in filename order. Naming the files individually is the
 * defect this replaces: a scratch database built from a prefix of
 * db/migrations tests a schema the venue does not run, and the next migration
 * to touch anything this file covers would silently reintroduce that - the
 * suite would keep passing against a schema that no longer exists.
 */
function allMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
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
      for (const file of allMigrations()) {
        await schema.query(migration(file));
      }
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

  /**
   * Laps straight into the table, in the volumes the row caps are about.
   * Validity is not what these ask about, so they skip computeValidity and land
   * valid, on the round's combo, `offsetSeconds` from now.
   */
  function bulkLaps(driverId: string, count: number, offsetSeconds: number) {
    return dbModule.query(
      `insert into laps (
         event_id, rig_id, rig_assignment_id, driver_id, track_name, track_config,
         car_name, lap_time_ms, incident_delta, is_valid, invalid_reason, completed_at
       )
       select 'bulk-' || ($1::uuid)::text || '-' || g, $2, $3, $1::uuid, $4, $5, $6,
              90000 + g, 0, true, null, now() + ($7::int * interval '1 second')
       from generate_series(1, $8::int) g`,
      [
        driverId,
        rigs[driverId],
        assignments[driverId],
        WEEK_ONE.trackName,
        WEEK_ONE.trackConfig,
        WEEK_ONE.carName,
        offsetSeconds,
        count,
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

  it("budgets laps per driver, so one long stint cannot empty another's list", async () => {
    const grinder = await driver("Ran All Night");
    const latecomer = await driver("Arrived Late");
    const round = await league.openLeagueRound(WEEK_ONE);

    // More laps than one round-wide request returns, all from one driver and
    // all earlier than the other's. The round page polls every expanded row in
    // a single call, so a budget shared across the named drivers and spent in
    // completed_at order would hand the latecomer a short list or nothing -
    // and the poll would then overwrite the laps their row already had.
    await bulkLaps(grinder, ROUND_LAP_CAP + 100, 0);
    await bulkLaps(latecomer, 3, 1);

    const page = await league.getRoundLaps(round.id, [grinder, latecomer]);
    const byDriver = lapsByDriver(page.laps);

    expect(byDriver[latecomer]).toHaveLength(3);
    expect(byDriver[grinder]).toHaveLength(DRIVER_LAP_CAP);
    expect(page.truncated).toBe(true);
  });

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

  /** Wait until some backend is blocked on a lock - a statement parked on
   *  another transaction's uncommitted row. Deterministic without a sleep. */
  async function waitForBlockedInsert() {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const row = await dbModule.queryOne<{ waiting: number }>(
        `select count(*)::int as waiting from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'`,
      );
      if ((row?.waiting ?? 0) > 0) return;
      if (Date.now() > deadline) throw new Error("statement never blocked");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it("rolls the losing round, its season and its league back when one is already open", async () => {
    // Both sides must start with NO committed open season, or the loser's
    // ensureOpenSeasonTx reuses the winner's and the season/league assertions
    // below can't fail whatever the rollback does. So the winner is held
    // uncommitted on its own client while the real openLeagueRound() runs: it
    // sees no open season, builds its own league and season, then parks on
    // one_open_round_venue_wide until the winner commits.
    const winner = await dbModule.db().connect();
    let losing: ReturnType<typeof league.openLeagueRound> | undefined;
    try {
      await winner.query("begin");
      const winningLeague = await winner.query<{ id: string }>(
        "insert into leagues (name) values ($1) returning id",
        ["Wednesday Night League"],
      );
      const winningSeason = await winner.query<{ id: string }>(
        "insert into league_seasons (league_id, name) values ($1, $2) returning id",
        [winningLeague.rows[0].id, "August 2026"],
      );
      const winningRound = await winner.query<{ id: string }>(
        `insert into league_rounds (season_id, round_number, name, track_name, track_config, car_name)
         values ($1, 1, $2, $3, $4, $5) returning id`,
        [
          winningSeason.rows[0].id,
          WEEK_ONE.name,
          WEEK_ONE.trackName,
          WEEK_ONE.trackConfig,
          WEEK_ONE.carName,
        ],
      );

      losing = league.openLeagueRound({
        name: "Week 2",
        trackName: "Monza",
        trackConfig: null,
        carName: "Mazda MX-5",
        incidentLimit: 0,
      });
      losing.catch(() => {}); // it is awaited below; don't trip on the gap

      await waitForBlockedInsert();
      await winner.query("commit");

      await expect(losing).rejects.toMatchObject({ code: "23505" });

      const open = await league.getOpenRound();
      expect(open?.id).toBe(winningRound.rows[0].id);
    } catch (error) {
      await winner.query("rollback").catch(() => {});
      throw error;
    } finally {
      winner.release();
    }

    // The whole losing transaction had to go, not just its round: a leftover
    // season would be picked up by getActiveSeason() later and quietly split
    // the championship in two, and a leftover league would outlive it.
    expect(await counts()).toEqual({ rounds: 1, seasons: 1, leagues: 1 });
    // ...including the featured-combo overwrite it never got to commit.
    expect(await featuredCombo()).toBeNull();
  });

  it("puts a round opened during a season roll into the new season, not the ended one", async () => {
    // Seed a committed open season with a finished round, the state a venue is
    // in on the first of the month.
    const first = await league.openLeagueRound(WEEK_ONE);
    await league.closeLeagueRound(first.id);
    const endingSeason = (await league.getActiveSeason())!;

    // The roll is held mid-transaction on its own client, having taken the
    // same `for update` lock rollLeagueSeason takes, while the real
    // openLeagueRound() runs against it. Before ensureOpenSeasonTx locked that
    // row, the opener read the pre-roll snapshot and attached tonight's round
    // to the month being closed, where /league would never show it again.
    const roller = await dbModule.db().connect();
    let opening: ReturnType<typeof league.openLeagueRound> | undefined;
    try {
      await roller.query("begin");
      await roller.query(
        `select id from league_seasons where ended_on is null
         order by started_on desc, created_at desc limit 1
         for update`,
      );
      await roller.query("update league_seasons set ended_on = venue_today() where id = $1", [
        endingSeason.id,
      ]);
      const replacement = await roller.query<{ id: string }>(
        "insert into league_seasons (league_id, name) values ($1, $2) returning id",
        [endingSeason.league_id, "Next Month"],
      );

      opening = league.openLeagueRound({
        name: "Week 1",
        trackName: "Monza",
        trackConfig: null,
        carName: "Mazda MX-5",
        incidentLimit: 0,
      });
      opening.catch(() => {}); // awaited below; don't trip on the gap

      await waitForBlockedInsert();
      await roller.query("commit");

      const opened = await opening;
      expect(opened.seasonId).toBe(replacement.rows[0].id);
      expect(opened.seasonId).not.toBe(endingSeason.id);
      expect(opened.roundNumber).toBe(1);
    } catch (error) {
      await roller.query("rollback").catch(() => {});
      throw error;
    } finally {
      roller.release();
    }

    // The ended month keeps only its own round, and no third season appeared.
    expect(await counts()).toMatchObject({ seasons: 2, rounds: 2 });
    expect(await league.listSeasonRounds(endingSeason.id)).toHaveLength(1);
  });

  it("recovers through the season savepoint when another opener creates the season first", async () => {
    // A league with no open season. rollLeagueSeason always creates the
    // replacement inside the transaction that ends the old one, and
    // ensureOpenSeasonTx creates league and season together, so the app never
    // leaves this state on its own - it is arranged here because it is what
    // puts two openers on the same league_id, the only way to collide on
    // one_open_season_per_league.
    const league_ = await dbModule.queryOne<{ id: string }>(
      "insert into leagues (name) values ('Wednesday Night League') returning id",
    );

    // The competing opener, held mid-transaction on its own client: it has run
    // ensureOpenSeasonTx's insert but not committed. Promise.allSettled over
    // two real calls cannot test this - whether the two transactions overlap in
    // that window is up to connection timing, and when they do not the test
    // passes with the savepoint removed. Holding one open makes the collision
    // certain. It stops short of inserting a round on purpose: with no round in
    // the way, the recovery's result is visible as success rather than being
    // masked by one_open_round_venue_wide.
    const other = await dbModule.db().connect();
    let opening: ReturnType<typeof league.openLeagueRound> | undefined;
    try {
      await other.query("begin");
      const otherSeason = await other.query<{ id: string }>(
        "insert into league_seasons (league_id, name) values ($1, $2) returning id",
        [league_!.id, "Held Season"],
      );

      opening = league.openLeagueRound(WEEK_ONE);
      opening.catch(() => {}); // awaited below; don't trip on the gap

      // The opener is now parked on one_open_season_per_league.
      await waitForBlockedInsert();
      await other.query("commit");

      // Without the savepoint that collision aborts the whole open-round
      // transaction and this rejects. With it, the opener rolls back just the
      // failed insert, re-reads, and adopts the season the other one committed.
      const opened = await opening;
      expect(opened.seasonId).toBe(otherSeason.rows[0].id);
      expect(opened.roundNumber).toBe(1);
    } catch (error) {
      await other.query("rollback").catch(() => {});
      throw error;
    } finally {
      other.release();
    }

    // One league, one open season, one round - no duplicate season survived the
    // race, and the round belongs to the season that won it.
    expect(await counts()).toEqual({ leagues: 1, seasons: 1, rounds: 1 });
    const season = await league.getActiveSeason();
    expect(await league.listSeasonRounds(season!.id)).toHaveLength(1);
  });

  it("ends the running season and starts the next one in its place", async () => {
    const round = await league.openLeagueRound(WEEK_ONE);

    // A live round would be orphaned out of the standings, so the roll is
    // refused rather than silently stranding it.
    expect(await league.rollLeagueSeason()).toMatchObject({
      status: "round_open",
      roundId: round.id,
    });

    await league.closeLeagueRound(round.id);

    const before = await league.getActiveSeason();
    const rolled = await league.rollLeagueSeason();
    if (rolled.status !== "rolled") throw new Error(`did not roll: ${rolled.status}`);
    expect(rolled.endedSeasonId).toBe(before!.id);

    // Exactly one season is open, it is the new one, and the old one keeps its
    // rounds - so the standings board starts clean without losing history.
    const after = await league.getActiveSeason();
    expect(after!.id).toBe(rolled.seasonId);
    expect(after!.name).toBe(venueMonthName());
    expect(after!.league_id).toBe(before!.league_id);
    expect((await league.getSeason(before!.id))!.ended_on).toBe(venueToday());
    expect(await league.listSeasonRounds(before!.id)).toHaveLength(1);
    expect(await league.listSeasonRounds(after!.id)).toHaveLength(0);

    // The next round lands in the new season, numbered from one again.
    const next = await league.openLeagueRound(WEEK_ONE);
    expect(next.seasonId).toBe(after!.id);
    expect(next.roundNumber).toBe(1);
  });

  it("has nothing to roll when no season has ever been opened", async () => {
    expect(await league.rollLeagueSeason()).toEqual({ status: "no_season" });
  });
});
