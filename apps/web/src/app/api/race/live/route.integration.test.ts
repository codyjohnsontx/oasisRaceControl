import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, expect, it } from "vitest";
import { POST } from "../../agent/race-status/route";
import { GET } from "./route";
import type { RaceStatusEvent } from "@/lib/events";
import type { LiveRace } from "@/lib/race-live";
import {
  closeTestDb,
  describeDb,
  openAssignment,
  resetDb,
  seedDriver,
  seedRig,
  testDb,
  type SeededRig,
} from "@/test/db";

/**
 * The live race loop against real Postgres, from a rig's report to the public
 * feed: one row per rig replaced on every report, rows grouped into iRacing
 * sessions, race order, staleness judged by the database clock, and each rig
 * joined to whoever is checked in on it. The rules themselves are unit-tested
 * in src/lib/race-live.test.ts; this is what only the database can show.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..", "..");

const RACE: RaceStatusEvent = {
  sampledAt: new Date().toISOString(),
  sessionUniqueId: 81_234_567,
  sessionNum: 2,
  sessionType: "Race",
  sessionState: 4,
  sessionFlags: 0x8000_0004,
  sessionTimeRemainS: 1_200,
  sessionLapsRemain: null,
  carIdx: 0,
  position: 1,
  classPosition: 1,
  lap: 5,
  lapsCompleted: 4,
  lapDistPct: 0.42,
  gapToLeaderS: 0,
  lastLapMs: 138_210,
  bestLapMs: 137_904,
  onPitRoad: false,
  incidents: 0,
};

async function report(rig: SeededRig, change: Partial<RaceStatusEvent>): Promise<void> {
  const res = await POST(
    new Request("http://localhost/api/agent/race-status", {
      method: "POST",
      headers: { authorization: `Bearer ${rig.agentToken}` },
      body: JSON.stringify({ ...RACE, sampledAt: new Date().toISOString(), ...change }),
    }),
  );
  expect(res.status).toBe(200);
}

async function live(): Promise<LiveRace> {
  const res = await GET();
  expect(res.status).toBe(200);
  return res.json();
}

/** Ages a rig's report by moving its arrival back, as silence would. */
async function silence(rig: SeededRig, seconds: number): Promise<void> {
  await testDb().query(
    "update rig_race_status set received_at = now() - make_interval(secs => $2) where rig_id = $1",
    [rig.id, seconds],
  );
}

describeDb("the live race feed against real Postgres", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("keeps one row per rig, replaced by each report", async () => {
    const rig = await seedRig(7);
    await report(rig, { position: 3, lap: 5 });
    await report(rig, { position: 2, lap: 6, sessionFlags: 1 });

    const { rows } = await testDb().query(
      `select position, lap, session_flags, sampled_at is not null as sampled,
              received_at <= now() as received
       from rig_race_status where rig_id = $1`,
      [rig.id],
    );
    // bigint comes back from pg as a string.
    expect(rows).toEqual([{ position: 2, lap: 6, session_flags: "1", sampled: true, received: true }]);
  });

  it("stores the full unsigned flags word iRacing sends", async () => {
    const rig = await seedRig(1);
    await report(rig, { sessionFlags: 0xffff_ffff });

    expect((await live()).session?.sessionFlags).toBe(0xffff_ffff);
  });

  it("shows two cars trading places within one report each", async () => {
    const [a, b, c] = [await seedRig(1), await seedRig(2), await seedRig(3)];
    await report(a, { position: 1, gapToLeaderS: 0 });
    await report(b, { position: 2, gapToLeaderS: 0.8 });
    await report(c, { position: 3, gapToLeaderS: 2.1 });
    expect((await live()).rows.map((r) => r.rigNumber)).toEqual([1, 2, 3]);

    // Rig 2 passes rig 1.
    await report(b, { position: 1, gapToLeaderS: 0 });
    await report(a, { position: 2, gapToLeaderS: 0.3 });

    const race = await live();
    expect(race.rows.map((r) => [r.rigNumber, r.position, r.intervalS])).toEqual([
      [2, 1, null],
      [1, 2, 0.3],
      [3, 3, expect.closeTo(1.8, 5)],
    ]);
  });

  it("returns the largest session as the race and counts the rigs elsewhere", async () => {
    const [a, b, c, d] = [await seedRig(1), await seedRig(2), await seedRig(3), await seedRig(4)];
    await report(a, { position: 1 });
    await report(b, { position: 2 });
    // Same server, still in practice.
    await report(c, { sessionNum: 0, sessionType: "Practice", position: 1 });
    // Another server entirely.
    await report(d, { sessionUniqueId: 99, position: 1 });

    const race = await live();
    expect(race.session).toMatchObject({ sessionUniqueId: 81_234_567, sessionNum: 2, isRace: true });
    expect(race.rows.map((r) => r.rigNumber)).toEqual([1, 2]);
    expect(race.otherRigs).toBe(2);
  });

  it("marks a rig silent past 15 s stale and drops it after 60 s, by the database clock", async () => {
    const [a, b, c] = [await seedRig(1), await seedRig(2), await seedRig(3)];
    await report(a, { position: 1 });
    await report(b, { position: 2 });
    await report(c, { position: 3 });
    await silence(b, 20);
    await silence(c, 61);

    const race = await live();
    expect(race.rows.map((r) => [r.rigNumber, r.stale])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(race.rows[1]!.ageS).toBeGreaterThanOrEqual(20);
  });

  it("is empty once every rig has gone quiet", async () => {
    const rig = await seedRig(1);
    await report(rig, {});
    await silence(rig, 61);

    expect(await live()).toEqual({ session: null, rows: [], otherRigs: 0 });
  });

  it("names each rig's checked-in driver, and no one once they sign out", async () => {
    const [a, b] = [await seedRig(4), await seedRig(7)];
    const mike = await seedDriver("Mike");
    const stint = await openAssignment(a.id, mike.id);
    await report(a, { position: 1 });
    await report(b, { position: 2 });

    expect((await live()).rows.map((r) => [r.rigNumber, r.driverId, r.driverName])).toEqual([
      [4, mike.id, "Mike"],
      [7, null, null],
    ]);

    await testDb().query(
      "update rig_assignments set ended_at = now(), end_reason = 'switched' where id = $1",
      [stint],
    );
    expect((await live()).rows[0]).toMatchObject({ rigNumber: 4, driverId: null, driverName: null });
  });

  it("passes the read-only verify the owner runs after hand-applying 0008", async () => {
    const verify = readFileSync(join(REPO_ROOT, "db", "verify", "0008_race_status.sql"), "utf8");
    const client = await testDb().connect();
    try {
      await client.query(
        `create temporary table schema_migrations (version text primary key);
         insert into schema_migrations values ('0008_race_status.sql')`,
      );
      const { rows } = await client.query<{ check_name: string; ok: boolean }>(verify);

      expect(rows).toHaveLength(4);
      expect(rows.filter((check) => !check.ok)).toEqual([]);
    } finally {
      await client.query("drop table if exists pg_temp.schema_migrations");
      client.release();
    }
  });
});
