import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb } from "./db";
import { safeTestDatabaseUrl } from "./db-guard";

/**
 * The upgrade path, as production will take it: a database already carrying
 * laps under the previous schema, with the next migration applied on top
 * inside the runner's per-file transaction (scripts/migrate.ts).
 *
 * global-setup.ts applies every migration to an empty database, which proves
 * the files parse and compose but says nothing about a migration that has to
 * backfill or constrain rows that already exist. That is precisely where an
 * additive migration goes wrong on the venue's database and nowhere else, so
 * this suite builds its own scratch database at the earlier schema, gives it
 * data, and only then applies the migration under test.
 */

const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "db", "migrations");
const SCRATCH_DB = `oasis_upgrade_test_${process.pid}`;

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Applies one migration file the way the runner does: all or nothing. */
async function apply(client: Client, file: string): Promise<void> {
  await client.query("begin");
  try {
    await client.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

/** Every migration strictly before `upTo`, in apply order. */
function migrationsBefore(upTo: string): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql") && file < upTo)
    .sort();
}

describeDb("0004_unattributed_cause on a database already at 0003", () => {
  const UPGRADE = "0004_unattributed_cause.sql";
  let admin: Client;
  let db: Client;
  /** The rig and open assignment the fixture seeded, for tests that need to
   *  write their own laps without reading another test's rows. */
  let rigId: string;
  let assignmentId: string;
  let driverId: string;

  // The whole fixture - a database at 0003 carrying laps, then upgraded - is
  // built here rather than inside the first test, so that no test in this file
  // depends on another test's body having run. Each `it` below only asserts.
  beforeAll(async () => {
    const serverUrl = safeTestDatabaseUrl()!;
    admin = new Client({ connectionString: withDatabase(serverUrl, "postgres") });
    await admin.connect();
    await admin.query(`drop database if exists ${SCRATCH_DB} with (force)`);
    await admin.query(`create database ${SCRATCH_DB}`);

    db = new Client({ connectionString: withDatabase(serverUrl, SCRATCH_DB) });
    await db.connect();
    for (const file of migrationsBefore(UPGRADE)) await apply(db, file);

    // A rig with one owned lap and one unclaimed lap, in the shape 0003 stored
    // them: no cause column exists yet, so there is nothing to say why.
    const { rows: [rig] } = await db.query<{ id: string }>(
      "insert into rigs (rig_number, display_name) values (1, 'Rig 01') returning id",
    );
    const { rows: [driver] } = await db.query<{ id: string }>(
      "insert into drivers (display_name) values ('Cody J') returning id",
    );
    const { rows: [assignment] } = await db.query<{ id: string }>(
      "insert into rig_assignments (rig_id, driver_id) values ($1, $2) returning id",
      [rig!.id, driver!.id],
    );
    rigId = rig!.id;
    driverId = driver!.id;
    assignmentId = assignment!.id;

    await db.query(
      `insert into laps (event_id, rig_id, rig_assignment_id, driver_id, track_name,
                         car_name, lap_time_ms, is_valid, invalid_reason, completed_at)
       values ('evt-owned', $1, $2, $3, 'Spa-Francorchamps', 'Porsche 911 GT3 R',
               90000, true, null, now()),
              ('evt-unclaimed', $1, null, null, 'Spa-Francorchamps', 'Porsche 911 GT3 R',
               90001, false, 'UNATTRIBUTED', now())`,
      [rigId, assignmentId, driverId],
    );

    // The runner wraps each file in a transaction, and 0003's header warns that
    // an enum label added there cannot be used until commit. 0004 creates its
    // type and uses it in the same transaction, which Postgres allows - but
    // only a real apply proves the file does not trip that rule.
    await apply(db, UPGRADE);
  });

  afterAll(async () => {
    await db?.end();
    await admin?.query(`drop database if exists ${SCRATCH_DB} with (force)`);
    await admin?.end();
  });

  it("applies in one transaction and backfills the laps that predate it", async () => {
    const { rows } = await db.query(
      "select event_id, unattributed_cause from laps order by event_id",
    );
    // The owned lap says nothing; the unclaimed one says the honest thing about
    // a cause nobody kept, rather than being guessed at or left to fail the
    // constraint.
    expect(rows).toEqual([
      { event_id: "evt-owned", unattributed_cause: null },
      { event_id: "evt-unclaimed", unattributed_cause: "not_recorded" },
    ]);

    // Fully validated - it holds for the backfilled rows, not just new ones.
    const constraint = await db.query(
      "select convalidated from pg_constraint where conname = 'laps_unattributed_has_cause'",
    );
    expect(constraint.rows).toEqual([{ convalidated: true }]);
  });

  it("keeps the previous deployment's ingestion working until the new code deploys", async () => {
    // docs/deploy.md: migrate first, then deploy, and a database ahead of the
    // code is harmless. Between those two steps the running ingestion still
    // inserts in the 0003 shape - no cause column at all. Both kinds of lap it
    // writes must still land: the ownerless one with the honest label, the
    // owned one with none.
    await db.query(
      `insert into laps (event_id, rig_id, rig_assignment_id, driver_id, track_name,
                         car_name, lap_time_ms, is_valid, invalid_reason, completed_at)
       values ('evt-old-writer-unclaimed', $1, null, null, 'Spa-Francorchamps',
               'Porsche 911 GT3 R', 90002, false, 'UNATTRIBUTED', now()),
              ('evt-old-writer-owned', $1, $2, $3, 'Spa-Francorchamps',
               'Porsche 911 GT3 R', 90003, true, null, now())`,
      [rigId, assignmentId, driverId],
    );

    const { rows } = await db.query(
      `select event_id, unattributed_cause from laps
       where event_id like 'evt-old-writer-%' order by event_id`,
    );
    expect(rows).toEqual([
      { event_id: "evt-old-writer-owned", unattributed_cause: null },
      { event_id: "evt-old-writer-unclaimed", unattributed_cause: "not_recorded" },
    ]);
  });
});
