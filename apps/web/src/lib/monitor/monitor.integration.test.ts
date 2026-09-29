import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import geminiAnswer from "./diagnosis/fixtures/gemini-generate-content.json";
import { runDiagnoses, runMonitor } from "./run";
import { applyFindings, claimEvaluation, type OpenAlert } from "./store";
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

type Post = { content?: string; embeds?: unknown[]; allowed_mentions: unknown };
let posts: Post[] = [];
let discordAnswers: number[] = [];

const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
  const status = discordAnswers.shift() ?? 204;
  if (status === 204) posts.push(JSON.parse(init.body as string) as Post);
  return new Response(status === 204 ? null : '{"message":"nope","code":0}', { status });
});

let consoleError: ReturnType<typeof vi.spyOn>;
let consoleLog: ReturnType<typeof vi.spyOn>;

/**
 * Lets the next runMonitor() past the throttle, as if 20 s had passed, and
 * runs the diagnosis stage after it the way both callers do.
 */
async function nextEvaluation() {
  await testDb().query("update monitor_state set last_evaluated_at = null");
  const run = await runMonitor();
  return run.evaluated ? { ...run, diagnosed: await runDiagnoses() } : run;
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
    agentVersion?: string;
    assignmentId?: string;
  } = {},
) {
  // The route's column layout: the fields rules filter on have columns, the rest is payload.
  await testDb().query(
    `insert into rig_heartbeats (rig_id, received_at, sent_at, clock_skew_ms,
       process_started_at, sim_connected, telemetry_faulted, pending_laps, rejected_laps,
       checkout, shutting_down, payload, agent_version, assignment_id)
     values ($1, now() - make_interval(secs => $2), now() - make_interval(secs => $3), 0,
       $4, true, false, 0, $5, 'none', $6, $7, $8, $9)`,
    [
      rig.id,
      agoS,
      fields.sentAgoS ?? agoS,
      PROCESS_STARTED,
      fields.rejectedLaps ?? 0,
      fields.shuttingDown ?? false,
      fields.sequence === undefined ? {} : { sequence: fields.sequence, telemetryMode: "iracing" },
      fields.agentVersion ?? null,
      fields.assignmentId ?? null,
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

/** Waits until `n` backends in the test database are waiting on a lock. */
async function waitForLockWaiters(n: number) {
  for (let i = 0; i < 100; i++) {
    const { rows } = await testDb().query<{ waiting: number }>(
      `select count(*)::int as waiting from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (rows[0]!.waiting >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no ${n} backend(s) waiting on a lock`);
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
      Array.from({ length: 8 }, () => applyFindings(db(), [finding], [])),
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
    const [opened] = (await applyFindings(db(), [finding], [])).announce;
    await testDb().query("update monitor_alerts set notified_at = now(), absent_evaluations = 1");
    const open: OpenAlert[] = [{ id: opened!, rule: finding.rule, subject: finding.subject }];

    const results = await Promise.all(Array.from({ length: 8 }, () => applyFindings(db(), [], open)));
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

  it("holds every other evaluation back until one has applied what it read", async () => {
    // A barrier: lock monitor_alerts against writes, so an evaluation gets
    // through its claim and snapshot and then waits to apply its transitions.
    const rig = await seedRig(1);
    await heartbeat(rig, 60, { rejectedLaps: 1 });
    const barrier = await testDb().connect();
    const rival = await testDb().connect();
    try {
      await barrier.query("begin; lock table monitor_alerts in exclusive mode");
      const first = runMonitor();
      await waitForLockWaiters(1);

      // Another evaluation's claim - the statement every evaluation starts
      // with - cannot get past the first one while it sits between reading
      // and applying. Were the claim its own transaction, this would answer
      // at once and a second snapshot could be applied before the first.
      await rival.query("begin; set local lock_timeout = '300ms'");
      await expect(claimEvaluation(rival)).rejects.toMatchObject({ code: "55P03" });
      await rival.query("rollback");

      await barrier.query("commit");
      await expect(first).resolves.toMatchObject({ evaluated: true, announced: 1 });

      // Once it has committed, the next claim goes straight through.
      await rival.query("begin; set local lock_timeout = '300ms'");
      await expect(claimEvaluation(rival)).resolves.toBeNull();
      await rival.query("rollback");
    } finally {
      // Never hand a client back to the pool mid-transaction: a claim it made
      // would hold monitor_state's lock against every later test.
      await barrier.query("rollback").catch(() => {});
      await rival.query("rollback").catch(() => {});
      barrier.release();
      rival.release();
    }
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

  it("stops retrying an hour after the alert opened, though the problem persists", async () => {
    const rig = await seedRig(1);
    await heartbeat(rig, 60, { rejectedLaps: 1 });
    discordAnswers = [500];
    await nextEvaluation();
    // An hour and more later, the problem still there on every evaluation
    // (which refreshes last_seen_at), and Discord still failing until now.
    await testDb().query(
      `update monitor_alerts set opened_at = now() - interval '61 minutes',
         notify_attempted_at = now() - interval '2 minutes',
         notify_until = now() - interval '1 minute'`,
    );

    await nextEvaluation();
    await nextEvaluation();
    expect(posts).toEqual([]);
    const { rows } = await testDb().query(
      "select now() - last_seen_at < interval '10 seconds' as fresh, notified_at from monitor_alerts",
    );
    expect(rows).toEqual([{ fresh: true, notified_at: null }]);

    // A rise in the count is a new announcement, with its own hour.
    await heartbeat(rig, 0, { rejectedLaps: 2 });
    await nextEvaluation();
    expect(posts.map((p) => p.content)).toEqual([
      `<@${OWNER}> 🔴 Rig 01: the site refused 2 laps; they are parked on the rig`,
    ]);
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

  it("keeps the last rig still off after a close dark, from runs older than the recent history", async () => {
    const [off, booted] = [await seedRig(1), await seedRig(2)];
    const closedS = 11 * 3600;
    for (const rig of [off, booted]) {
      for (const agoS of [closedS + 120, closedS + 60, closedS]) await heartbeat(rig, agoS);
    }
    // Booted half an hour ago: its pre-close run is out of the rules' recent
    // history, and only the heard runs show it went quiet with rig 1.
    for (let agoS = 1800; agoS >= 0; agoS -= 60) await heartbeat(booted, agoS);

    await nextEvaluation();

    expect(await alerts()).toEqual([]);
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

  describe("AI diagnosis and the copy-paste handoff", () => {
    const GEMINI = "https://generativelanguage.googleapis.com/";
    let geminiAnswers: Array<"timeout" | "answer"> = [];
    let prompts: string[] = [];

    beforeEach(() => {
      geminiAnswers = [];
      prompts = [];
      vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
      vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "9b4fd5d0c0ffee");
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          if (!url.startsWith(GEMINI)) return fetchMock(url, init);
          prompts.push(init.body as string);
          // What AbortSignal.timeout() rejects with when the 20 s run out.
          if (geminiAnswers.shift() !== "answer") throw new DOMException("timed out", "TimeoutError");
          return Response.json(geminiAnswer);
        }),
      );
    });

    async function diagnosis() {
      const { rows } = await testDb().query<{ diagnosis: Record<string, unknown> | null; handoff: string | null }>(
        "select diagnosis, handoff from monitor_alerts order by id",
      );
      return rows;
    }

    /** Moves the stored diagnosis's clocks back, as if `seconds` had passed. */
    async function age(seconds: number) {
      await testDb().query(
        `update monitor_alerts set diagnosis = diagnosis
           || jsonb_build_object('at', now() - make_interval(secs => $1))
           || case when diagnosis ? 'postAttemptedAt'
                   then jsonb_build_object('postAttemptedAt', now() - make_interval(secs => $1))
                   else '{}'::jsonb end`,
        [seconds],
      );
    }

    async function seatedSilentRig() {
      const rig = await seedRig(2);
      const driver = await seedDriver("Matt G");
      await openAssignment(rig.id, driver.id);
      for (const ago of [600, 540, 480, 420, 360, 300, 240, 180]) await heartbeat(rig, ago);
    }

    it("posts the alert alone when the model times out, retries once, then posts diagnosis and handoff", async () => {
      await seatedSilentRig();
      geminiAnswers = ["timeout", "answer"];

      await nextEvaluation();
      expect(posts.map((p) => p.content)).toEqual([
        `<@${OWNER}> 🔴 Rig 02 has been silent for 3 min with Matt G signed in`,
      ]);
      expect(await diagnosis()).toMatchObject([
        { diagnosis: { status: "retry", attempts: 1, error: "timed out" }, handoff: null },
      ]);

      // Not before a minute has passed.
      await nextEvaluation();
      expect(prompts).toHaveLength(1);

      await age(90);
      await expect(nextEvaluation()).resolves.toMatchObject({ diagnosed: 1 });
      expect(prompts).toHaveLength(2);
      expect(posts).toHaveLength(3);
      expect(posts[1]).toMatchObject({
        embeds: [{ title: "Likely cause (Gemini, confidence medium)" }],
        allowed_mentions: { parse: [] },
      });
      expect(posts[2]!.content).toMatch(/^```text\nOasis rig alert #\d+ - rule 1: Rig silent \(Rig 02\)\n/);
      expect(posts[2]!.content).toContain("Site commit: 9b4fd5d");
      expect(posts[2]!.content).toContain("Likely cause (AI, confidence medium): The lap ingestion route");
      expect(posts[2]!.allowed_mentions).toEqual({ parse: [] });
      expect(await diagnosis()).toMatchObject([
        {
          diagnosis: {
            status: "done",
            attempts: 2,
            provider: "gemini",
            model: "gemini-2.5-flash",
            result: { causeClass: "software" },
            diagnosisPostedAt: expect.any(String),
            handoffPostedAt: expect.any(String),
          },
          handoff: expect.stringMatching(/^Oasis rig alert #/),
        },
      ]);

      // The driver's name reached Discord in the alert, and nowhere else.
      for (const prompt of prompts) expect(prompt).not.toContain("Matt G");
      expect(posts[2]!.content).not.toContain("Matt G");

      // Nothing more, however many evaluations follow.
      await age(600);
      await nextEvaluation();
      await nextEvaluation();
      expect(prompts).toHaveLength(2);
      expect(posts).toHaveLength(3);
    });

    it("posts the handoff without the model's lines once the retry fails too", async () => {
      await seatedSilentRig();

      await nextEvaluation();
      await age(90);
      await expect(nextEvaluation()).resolves.toMatchObject({ diagnosed: 0 });

      expect(prompts).toHaveLength(2);
      expect(posts).toHaveLength(2);
      expect(posts[1]!.content).toContain("Likely cause (AI): no diagnosis (timed out)");
      expect(await diagnosis()).toMatchObject([
        { diagnosis: { status: "done", attempts: 2, error: "timed out", handoffPostedAt: expect.any(String) } },
      ]);

      await age(600);
      await nextEvaluation();
      expect(prompts).toHaveLength(2);
      expect(posts).toHaveLength(2);
    });

    it("finishes a half-posted diagnosis later without posting the first half twice", async () => {
      await seatedSilentRig();
      geminiAnswers = ["answer"];
      // The alert and the diagnosis go through; the handoff is refused.
      discordAnswers = [204, 204, 500];

      await nextEvaluation();
      expect(posts).toHaveLength(2);

      await nextEvaluation();
      expect(posts).toHaveLength(2);

      await age(90);
      await nextEvaluation();
      expect(posts).toHaveLength(3);
      expect(posts[2]!.content).toMatch(/^```text\nOasis rig alert #/);
      expect(prompts).toHaveLength(1);
    });

    it("never diagnoses a rig alert whose detail does not say who was seated", async () => {
      const opened = async (subject: string, driver?: string) => {
        const finding: Finding = {
          rule: "rig_silent",
          subject,
          severity: "urgent",
          level: 0,
          detail: {
            headline: "Rig 09 has been silent for 3 min with Matt G signed in",
            where: "Rig 09",
            fields: [{ name: "Driver", value: "Matt G (seated 18 min)" }],
            ...(driver === undefined ? {} : { driver }),
          },
        };
        await applyFindings(db(), [finding], []);
      };
      await opened("rig:00000000-0000-4000-8000-000000000001");
      await opened("rig:00000000-0000-4000-8000-000000000002", "Matt G");
      await testDb().query("update monitor_alerts set notified_at = now()");
      geminiAnswers = ["answer"];

      await nextEvaluation();

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("Rig 09 has been silent for 3 min with driver-");
      expect(prompts[0]).not.toContain("Matt G");
      expect(await diagnosis()).toMatchObject([{ diagnosis: null }, { diagnosis: { status: "done" } }]);
    });

    it("hands the model and the handoff the rig state stored in heartbeat columns", async () => {
      const rig = await seedRig(2);
      const driver = await seedDriver("Matt G");
      const assignmentId = await openAssignment(rig.id, driver.id);
      for (const ago of [600, 540, 480, 420, 360, 300, 240, 180]) {
        await heartbeat(rig, ago, { agentVersion: "1.4.2", assignmentId });
      }
      geminiAnswers = ["answer"];

      await nextEvaluation();

      expect(posts).toHaveLength(3);
      const handoff = posts[2]!.content!;
      expect(handoff).toContain("· agent 1.4.2\n");
      expect(handoff).toMatch(/Rig state \(last 3 heartbeats\): \d\d:\d\d:\d\d, sim connected, pending 0, skew \+0\.0 s;/);
      const heartbeats = JSON.parse(prompts[0]!).contents[0].parts[0].text;
      expect(heartbeats).toContain('"agentVersion": "1.4.2"');
      expect(heartbeats).toContain('"simConnected": true');
      expect(heartbeats).toContain('"pendingLaps": 0');
      expect(heartbeats).toContain('"driverSeated": true');
      expect(heartbeats).not.toContain(assignmentId);
    });

    it("makes no call without a key, and posts the alert as before", async () => {
      vi.stubEnv("GEMINI_API_KEY", "");
      await seatedSilentRig();

      await nextEvaluation();
      await nextEvaluation();
      expect(prompts).toHaveLength(0);
      expect(posts).toHaveLength(1);
      expect(await diagnosis()).toMatchObject([{ diagnosis: null, handoff: null }]);
    });
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

  it("fails the verify for an alert id that is a plain bigint rather than an identity", async () => {
    // The near miss a hand paste can make: every column name, type, default
    // and constraint as written, but no generator - so the first alert insert
    // fails. Inside a transaction that is rolled back.
    const verify = readFileSync(join(REPO_ROOT, "db", "verify", "0006_monitor.sql"), "utf8");
    const client = await testDb().connect();
    try {
      await client.query("begin");
      await client.query("insert into monitor_state (id) values (1) on conflict do nothing");
      await client.query(
        `create temporary table schema_migrations (version text primary key) on commit drop;
         insert into schema_migrations values ('0006_monitor.sql')`,
      );
      await client.query("alter table monitor_alerts alter column id drop identity");
      const { rows } = await client.query<{ check_name: string; ok: boolean }>(verify);

      expect(rows.filter((check) => !check.ok).map((check) => check.check_name)).toEqual([
        "alerts columns",
      ]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
