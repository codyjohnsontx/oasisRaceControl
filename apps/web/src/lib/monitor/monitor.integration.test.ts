import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMonitor } from "./run";
import { applyFindings, nextVenueMidnightSql, type OpenAlert } from "./store";
import type { Finding } from "./rules";
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
 * The monitor against real Postgres: the guarantees that live in SQL. An
 * alert fires once however many evaluations see it at once (the partial
 * unique index), it never repeats while the problem persists, it recovers
 * once and only after two evaluations without it, a failed post is retried
 * without being posted twice, and the throttle and the pruning claim hold
 * across concurrent callers. Discord is a fake fetch; nothing posts anywhere.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const WEBHOOK = "https://discord.test/api/webhooks/1/token";
const OWNER = "123456789012345678";
/** One agent process, as the agent names it: the same instant on every heartbeat. */
const PROCESS_STARTED = new Date(Date.now() - 3 * 3_600_000);

type Post = {
  content?: string;
  embeds?: Array<{ description?: string; color?: number }>;
  allowed_mentions: unknown;
};
let posts: Post[] = [];
let discordAnswers: number[] = [];

const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
  const status = discordAnswers.shift() ?? 204;
  if (status === 204) posts.push(JSON.parse(init.body as string) as Post);
  return new Response(status === 204 ? null : '{"message":"nope","code":0}', { status });
});

let consoleError: ReturnType<typeof vi.spyOn>;
let consoleLog: ReturnType<typeof vi.spyOn>;

/** Lets the next runMonitor() past the throttle, as if 20 s had passed. */
async function nextEvaluation() {
  await testDb().query("update monitor_state set last_evaluated_at = null");
  return runMonitor();
}

/**
 * Stores a heartbeat `agoS` seconds old and moves rigs.last_seen_at to it if it
 * is the newest, as the ingestion route does.
 */
async function heartbeat(
  rig: SeededRig,
  agoS: number,
  fields: {
    shuttingDown?: boolean;
    sequence?: number;
    sentAgoS?: number;
    rejectedLaps?: number;
  } = {},
) {
  await testDb().query(
    `insert into rig_heartbeats (rig_id, received_at, sent_at, clock_skew_ms,
       process_started_at, sim_connected, telemetry_faulted, pending_laps, rejected_laps,
       checkout, shutting_down, payload)
     values ($1, now() - make_interval(secs => $2), now() - make_interval(secs => $3), 0,
       $4, true, false, 0, $5, 'none', $6, $7)`,
    [
      rig.id,
      agoS,
      fields.sentAgoS ?? agoS,
      PROCESS_STARTED,
      fields.rejectedLaps ?? 0,
      fields.shuttingDown ?? false,
      fields.sequence === undefined ? {} : { sequence: fields.sequence, telemetryMode: "iracing" },
    ],
  );
  await testDb().query(
    `update rigs set last_seen_at = greatest(last_seen_at, now() - make_interval(secs => $2))
     where id = $1`,
    [rig.id, agoS],
  );
  await testDb().query(
    "update rigs set last_seen_at = now() - make_interval(secs => $2) where id = $1 and last_seen_at is null",
    [rig.id, agoS],
  );
}

async function alerts() {
  const { rows } = await testDb().query<{
    rule: string;
    subject: string;
    level: number;
    resolved: boolean;
    notified: boolean;
    recovery_notified: boolean;
  }>(
    `select rule, subject, level, resolved_at is not null as resolved,
            notified_at is not null as notified,
            recovery_notified_at is not null as recovery_notified
     from monitor_alerts order by id`,
  );
  return rows;
}

describeDb("rig monitor against real Postgres", () => {
  beforeEach(async () => {
    await resetDb();
    posts = [];
    discordAnswers = [];
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("DISCORD_WEBHOOK_URL", WEBHOOK);
    vi.stubEnv("DISCORD_ALERT_USER_ID", OWNER);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    consoleError.mockRestore();
    consoleLog.mockRestore();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("opens one alert when two evaluations see the same problem at once", async () => {
    const finding: Finding = {
      rule: "telemetry_faulted",
      subject: "rig:concurrency",
      severity: "urgent",
      level: 0,
      detail: { headline: "Rig 01: lap reading stopped", where: "Rig 01", fields: [] },
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => applyFindings([finding], [])),
    );

    expect(results.flatMap((r) => r.announce)).toHaveLength(1);
    const { rows } = await testDb().query("select * from monitor_alerts");
    expect(rows).toHaveLength(1);
  });

  it("recovers an alert once when two evaluations both see it gone", async () => {
    const finding: Finding = {
      rule: "telemetry_faulted",
      subject: "rig:concurrency",
      severity: "urgent",
      level: 0,
      detail: { headline: "x", where: "Rig 01", fields: [] },
    };
    const [opened] = (await applyFindings([finding], [])).announce;
    await testDb().query("update monitor_alerts set notified_at = now(), absent_evaluations = 1");
    const open: OpenAlert[] = [{ id: opened!, rule: finding.rule, subject: finding.subject }];

    const results = await Promise.all(Array.from({ length: 8 }, () => applyFindings([], open)));
    expect(results.flatMap((r) => r.recover)).toEqual([opened]);
  });

  it("posts a seated rig going silent once, never while it stays silent, and recovers once", async () => {
    const rig = await seedRig(2);
    const driver = await seedDriver("Matt G");
    await openAssignment(rig.id, driver.id);
    for (const ago of [600, 540, 480, 420, 360, 300, 240, 180]) await heartbeat(rig, ago);

    // Silent for three minutes with a driver seated: urgent, mentioning the owner.
    await expect(nextEvaluation()).resolves.toMatchObject({ evaluated: true, announced: 1 });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.content).toBe(`<@${OWNER}> 🔴 Rig 02 has been silent for 3 min with Matt G signed in`);
    expect(posts[0]!.allowed_mentions).toEqual({ parse: [], users: [OWNER] });

    // Still silent: nothing more, however many evaluations.
    await nextEvaluation();
    await nextEvaluation();
    expect(posts).toHaveLength(1);

    // Heard again. One evaluation without the problem is not yet a recovery...
    await heartbeat(rig, 0);
    await nextEvaluation();
    expect(posts).toHaveLength(1);
    expect(await alerts()).toMatchObject([{ rule: "rig_silent", resolved: false }]);

    // ...the second is, and says so once.
    await nextEvaluation();
    await nextEvaluation();
    expect(posts.map((p) => p.content)).toEqual([
      `<@${OWNER}> 🔴 Rig 02 has been silent for 3 min with Matt G signed in`,
      expect.stringMatching(/^🟢 Recovered: Rig silent - Rig 02 \(alert #\d+, after \d+ s\)$/),
    ]);
    expect(posts[1]!.allowed_mentions).toEqual({ parse: [] });
    expect(await alerts()).toMatchObject([{ resolved: true, notified: true, recovery_notified: true }]);
  });

  it("never posts or stores the name of a driver whose name is under review", async () => {
    const rig = await seedRig(3);
    const driver = await seedDriver("Flagged Name");
    await testDb().query("update drivers set status = 'name_flagged' where id = $1", [driver.id]);
    await openAssignment(rig.id, driver.id);
    for (const ago of [600, 540, 480, 420, 360, 300, 240, 180]) await heartbeat(rig, ago);

    await nextEvaluation();
    expect(posts.map((p) => p.content)).toEqual([
      `<@${OWNER}> 🔴 Rig 03 has been silent for 3 min with a driver (name under review) signed in`,
    ]);
    const { rows } = await testDb().query<{ detail: unknown }>("select detail from monitor_alerts");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("Flagged Name");
  });

  it("does not open an alert for a goodbye an ordinary heartbeat landed after", async () => {
    // Stored the way the ingestion route stores them, with the sequence in the
    // payload: 42 was on the wire when 43 said goodbye, and arrived second.
    const rig = await seedRig(1);
    const driver = await seedDriver("Ada");
    await openAssignment(rig.id, driver.id);
    await heartbeat(rig, 900, { sequence: 41 });
    await heartbeat(rig, 840, { sequence: 43, shuttingDown: true });
    await heartbeat(rig, 839, { sequence: 42, sentAgoS: 845 });

    await nextEvaluation();
    expect(await alerts()).toEqual([]);
    expect(posts).toEqual([]);
  });

  it("does not throttle an evaluation that follows another by more than the interval, and does otherwise", async () => {
    const first = await nextEvaluation();
    const second = await runMonitor();
    expect(first.evaluated).toBe(true);
    expect(second.evaluated).toBe(false);

    await testDb().query("update monitor_state set last_evaluated_at = now() - interval '21 seconds'");
    await expect(runMonitor()).resolves.toMatchObject({ evaluated: true });
  });

  it("lets exactly one of many simultaneous evaluations run", async () => {
    const runs = await Promise.all(Array.from({ length: 6 }, () => runMonitor()));
    expect(runs.filter((r) => r.evaluated)).toHaveLength(1);
  });

  it("retries a post Discord refused, once, on a later evaluation", async () => {
    const rig = await seedRig(1);
    await heartbeat(rig, 60, { rejectedLaps: 1 });
    discordAnswers = [500];

    await nextEvaluation();
    expect(posts).toEqual([]);
    expect(await alerts()).toMatchObject([{ rule: "laps_refused", notified: false }]);

    // Too soon after the failed attempt: not retried yet.
    await nextEvaluation();
    expect(posts).toEqual([]);

    await testDb().query("update monitor_alerts set notify_attempted_at = now() - interval '61 seconds'");
    await nextEvaluation();
    await nextEvaluation();
    expect(posts.map((p) => p.content)).toEqual([
      `<@${OWNER}> 🔴 Rig 01: the site refused 1 lap; it is parked on the rig`,
    ]);
    expect(await alerts()).toMatchObject([{ notified: true }]);
  });

  it("stops retrying a post after an hour rather than flooding the channel later", async () => {
    const rig = await seedRig(1);
    await heartbeat(rig, 60, { rejectedLaps: 1 });
    discordAnswers = [500];
    await nextEvaluation();
    await testDb().query(
      `update monitor_alerts set notify_attempted_at = now() - interval '2 hours',
                                 last_seen_at = now() - interval '2 hours'`,
    );
    // The rig is gone from the snapshot, so the alert is not refreshed either.
    await testDb().query("delete from rig_heartbeats");

    await nextEvaluation();
    expect(posts).toEqual([]);
  });

  it("posts nothing and claims no retries without a webhook", async () => {
    vi.stubEnv("DISCORD_WEBHOOK_URL", "");
    const rig = await seedRig(1);
    await heartbeat(rig, 60, { rejectedLaps: 1 });

    await nextEvaluation();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await alerts()).toMatchObject([{ notified: false }]);
  });

  it("re-announces laps refused once per rise in the count, and not for a fall", async () => {
    const rig = await seedRig(1);
    await heartbeat(rig, 120, { rejectedLaps: 1 });
    await nextEvaluation();
    await heartbeat(rig, 60, { rejectedLaps: 3 });
    await nextEvaluation();
    await nextEvaluation();
    await heartbeat(rig, 30, { rejectedLaps: 2 });
    await nextEvaluation();
    await heartbeat(rig, 0, { rejectedLaps: 3 });
    await nextEvaluation();

    expect(posts.map((p) => p.content)).toEqual([
      `<@${OWNER}> 🔴 Rig 01: the site refused 1 lap; it is parked on the rig`,
      `<@${OWNER}> 🔴 Rig 01: the site refused 3 laps; they are parked on the rig`,
      `<@${OWNER}> 🔴 Rig 01: the site refused 3 laps; they are parked on the rig`,
    ]);
    expect(await alerts()).toMatchObject([{ rule: "laps_refused", level: 3, resolved: false }]);
  });

  it("prunes heartbeats past seven days at most once a day", async () => {
    const rig = await seedRig(1);
    await heartbeat(rig, 8 * 86_400);
    await heartbeat(rig, 6 * 86_400);
    await heartbeat(rig, 30);

    await nextEvaluation();
    const count = async () =>
      Number((await testDb().query("select count(*) from rig_heartbeats")).rows[0].count);
    expect(await count()).toBe(2);

    await heartbeat(rig, 9 * 86_400);
    await nextEvaluation();
    expect(await count()).toBe(3);
  });

  it("passes the read-only verify the owner runs after hand-applying 0006", async () => {
    // db/verify/0006_monitor.sql pins fingerprints of every object the
    // migration creates; this database was built from the migration itself, so
    // any row not ok means the migration and its verify have drifted apart.
    // resetDb() truncated the seed row the migration inserts, so it is put
    // back, and the runner's bookkeeping row is added for the duration.
    const verify = readFileSync(join(REPO_ROOT, "db", "verify", "0006_monitor.sql"), "utf8");
    const client = await testDb().connect();
    try {
      await client.query("insert into monitor_state (id) values (1) on conflict do nothing");
      await client.query(
        `create temporary table schema_migrations (version text primary key);
         insert into schema_migrations values ('0006_monitor.sql')`,
      );
      const { rows } = await client.query<{ check_name: string; ok: boolean }>(verify);

      expect(rows).toHaveLength(12);
      expect(rows.filter((check) => !check.ok)).toEqual([]);
    } finally {
      await client.query("drop table if exists pg_temp.schema_migrations");
      client.release();
    }
  });
  describe("event mode", () => {
    /** A /tv page's row, as the heartbeat route writes it. */
    async function board(fields: { mode?: string; lastSeenAgoS?: number; closedAgoS?: number } = {}) {
      const { rows } = await testDb().query<{ board_id: string }>(
        `insert into board_heartbeats (board_id, mode, host, first_seen_at, last_seen_at, visible,
           feed_ok, feed_failures, closed_at)
         values (gen_random_uuid(), $1, 'cadillac', now() - interval '1 hour',
                 now() - make_interval(secs => $2), true, true, 0,
                 case when $3::float8 is null then null else now() - make_interval(secs => $3) end)
         returning board_id::text`,
        [fields.mode ?? "event", fields.lastSeenAgoS ?? 10, fields.closedAgoS ?? null],
      );
      return rows[0]!.board_id;
    }

    async function setCombo() {
      await testDb().query(
        `insert into featured_combos (combo_date, track_name, track_config, car_name)
         values (venue_today(), 'Circuit of the Americas', 'Grand Prix', 'FIA F4')`,
      );
    }

    const contents = () => posts.map((p) => p.content);

    it("posts one line when an event board opens, the first update with it, and nothing more until the mark", async () => {
      await setCombo();
      await board();

      await expect(nextEvaluation()).resolves.toMatchObject({ eventMode: true, routineUpdate: true });
      expect(contents()).toEqual([
        expect.stringMatching(/^⚪ Event mode on: Event board \(Cadillac\) opened at \d{1,2}:\d{2} [AP]M$/),
        expect.stringMatching(/^🟢 Oasis event update · \d{1,2}:\d{2} [AP]M {2}\(next about \d{1,2}:\d{2} [AP]M\)$/),
      ]);
      expect(posts[1]!.embeds![0]!.description).toMatch(
        /^Board: live · Circuit of the Americas Grand Prix · FIA F4 · 0 drivers today · 0 laps in the last 20 min\n/,
      );

      await nextEvaluation();
      await nextEvaluation();
      expect(posts).toHaveLength(2);

      // Half a minute short of the mark: nothing.
      await testDb().query(
        "update monitor_state set last_routine_update_at = now() - interval '19 minutes 30 seconds'",
      );
      await nextEvaluation();
      expect(posts).toHaveLength(2);

      // Five seconds past it: the update, stamped with its mark rather than
      // with now, so the cadence does not drift later every time.
      const { rows } = await testDb().query<{ previous: string }>(
        `update monitor_state set last_routine_update_at = now() - interval '20 minutes 5 seconds'
         returning last_routine_update_at::text as previous`,
      );
      await expect(nextEvaluation()).resolves.toMatchObject({ routineUpdate: true });
      expect(posts).toHaveLength(3);
      const { rows: stamp } = await testDb().query<{ on_mark: boolean }>(
        "select last_routine_update_at = $1::timestamptz + interval '20 minutes' as on_mark from monitor_state",
        [rows[0]!.previous],
      );
      expect(stamp[0]!.on_mark).toBe(true);
    });

    it("posts no routine update and no event line outside event mode", async () => {
      const rig = await seedRig(1);
      await heartbeat(rig, 30);
      await board({ mode: "rotation" });
      await nextEvaluation();
      await nextEvaluation();
      expect(posts).toEqual([]);
      const { rows } = await testDb().query("select last_routine_update_at, event_mode from monitor_state");
      expect(rows).toEqual([{ last_routine_update_at: null, event_mode: false }]);
    });

    it("posts one line when the board says goodbye, and alerts on none", async () => {
      await setCombo();
      const id = await board();
      await nextEvaluation();
      posts = [];

      // The tab was closed three minutes ago, past a reload's grace.
      await testDb().query(
        "update board_heartbeats set last_seen_at = now() - interval '3 minutes', closed_at = now() - interval '3 minutes' where board_id = $1",
        [id],
      );
      await expect(nextEvaluation()).resolves.toMatchObject({ eventMode: false, announced: 0 });
      await nextEvaluation();
      expect(contents()).toEqual(["⚪ Event mode off: no event board is open"]);
      expect(await alerts()).toEqual([]);
    });

    it("alerts once, urgently, when the event board goes dark without a goodbye", async () => {
      await setCombo();
      await board({ lastSeenAgoS: 4 * 60 });
      await nextEvaluation();
      await nextEvaluation();
      await nextEvaluation();
      const dark = posts.filter((p) => p.content?.includes("has not been heard from"));
      expect(dark.map((p) => p.content)).toEqual([
        `<@${OWNER}> 🔴 Event board (Cadillac) has not been heard from for 4 min - laptop asleep, browser closed, or offline?`,
      ]);
      expect(await alerts()).toMatchObject([{ rule: "board_dark", subject: "board:event", resolved: false }]);
    });

    it("retries an event-mode line Discord refused on a later evaluation, once", async () => {
      await setCombo();
      await board();
      discordAnswers = [500];
      await nextEvaluation();
      expect(contents().filter((c) => c?.startsWith("⚪"))).toEqual([]);
      await nextEvaluation();
      await nextEvaluation();
      expect(contents().filter((c) => c?.startsWith("⚪ Event mode on"))).toHaveLength(1);
    });

    it("retries a 20-minute update Discord refused on the next evaluation", async () => {
      await setCombo();
      await board();
      discordAnswers = [204, 500];
      await expect(nextEvaluation()).resolves.toMatchObject({ routineUpdate: false });
      await expect(nextEvaluation()).resolves.toMatchObject({ routineUpdate: true });
      await nextEvaluation();
      expect(contents().filter((c) => c?.includes("Oasis event update"))).toHaveLength(1);
    });

    it("says no featured combo is set as soon as event mode is on", async () => {
      await board();
      await nextEvaluation();
      expect(await alerts()).toMatchObject([{ rule: "no_featured_combo", subject: "venue" }]);
      expect(posts[0]!.content).toMatch(new RegExp(`^<@${OWNER}> 🔴 No featured car and track is set for today, and event mode is on`));
    });

    it("lets a staff override lapse at the venue's midnight, not a UTC one, across daylight saving", async () => {
      const cases: Array<[string, string]> = [
        // 11:59:59 PM CDT on Oct 3 lapses one second later...
        ["2026-10-04T04:59:59Z", "2026-10-04T05:00:00.000Z"],
        // ...and one set at midnight exactly lasts the whole new day.
        ["2026-10-04T05:00:00Z", "2026-10-05T05:00:00.000Z"],
        // Nov 1, 2026 is 25 hours long: midnight after it is 06:00Z, not 05:00Z.
        ["2026-11-01T12:00:00Z", "2026-11-02T06:00:00.000Z"],
        // Mar 14, 2027 is 23 hours long.
        ["2027-03-14T12:00:00Z", "2027-03-15T05:00:00.000Z"],
      ];
      for (const [at, expected] of cases) {
        const { rows } = await testDb().query<{ lapses: Date }>(
          `select ${nextVenueMidnightSql("$1::timestamptz")} as lapses`,
          [at],
        );
        expect([at, rows[0]!.lapses.toISOString()]).toEqual([at, expected]);
      }
    });

    it("notes a gap in the checks once, on the evaluation that ends it", async () => {
      await testDb().query(
        "insert into monitor_state (id, last_evaluated_at) values (1, now() - interval '20 hours')",
      );
      await runMonitor();
      await nextEvaluation();
      expect(contents()).toEqual([
        expect.stringMatching(/^🟡 Monitor gap: no checks ran from .+ - is the outside clock \(cron-job\.org\) still running\?$/),
      ]);
    });

    it("prunes board heartbeats past seven days with the rig heartbeats", async () => {
      await board({ lastSeenAgoS: 8 * 86_400 });
      await board();
      await nextEvaluation();
      const { rows } = await testDb().query("select count(*)::int as n from board_heartbeats");
      expect(rows[0]!.n).toBe(1);
    });
  });

  it("passes the read-only verify the owner runs after hand-applying 0007", async () => {
    const verify = readFileSync(join(REPO_ROOT, "db", "verify", "0007_board_heartbeats.sql"), "utf8");
    const client = await testDb().connect();
    try {
      await client.query(
        `create temporary table schema_migrations (version text primary key);
         insert into schema_migrations values ('0007_board_heartbeats.sql')`,
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
