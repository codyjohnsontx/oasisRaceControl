import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import geminiAnswer from "./diagnosis/fixtures/gemini-generate-content.json";
import commentCreated from "./fixtures/github-comment-created.json";
import issueCreated from "./fixtures/github-issue-created.json";
import { rigAlertMarker } from "./handoff";
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

    async function seatedSilentRig(rigNumber = 2, driverName = "Matt G") {
      const rig = await seedRig(rigNumber);
      const driver = await seedDriver(driverName);
      await openAssignment(rig.id, driver.id);
      for (const ago of [600, 540, 480, 420, 360, 300, 240, 180]) await heartbeat(rig, ago);
      return rig;
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
      expect(posts[2]!.content).toMatch(/^```text\nOasis rig alert #\d+ - rule 1: Rig silent \(Rig 2\)\n/);
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
            rigNumber: 9,
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
      expect(prompts[0]).toContain("Rig 9 has been silent for 3 min with driver-");
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

    describe("the rig-alert GitHub issue", () => {
      const GITHUB = "https://api.github.com/repos/codyjohnsontx/oasisRaceControl/issues";
      const TOKEN = "github_pat_test_never_logged";
      /**
       * A fake GitHub that keeps what is written to it, so the marker lookups
       * read back what was filed. Each write takes the next answer:
       * a status (201/200 when none is queued); "lost", which lands the write
       * and then times out, as a dropped answer does; "hold", which lands it
       * only once `release` is called; or "echo", a 502 whose body quotes the
       * token and the request.
       */
      type Answer = number | "lost" | "hold" | "echo";
      const MONITOR = "oasis-monitor";
      type FakeComment = { body: string; user: { login: string } };
      type FakeIssue = {
        number: number;
        created_at: string;
        state: string;
        body: string;
        user: { login: string };
        labels: Array<{ name: string }>;
        comments: FakeComment[];
      };
      /** GitHub files the next issue without its label, as it does when the label is missing. */
      let dropLabel = false;
      let issues: Map<number, FakeIssue>;
      /** Every write to GitHub, in order; the reads are in `reads`. */
      let calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
      let reads: string[] = [];
      let githubAnswers: Answer[] = [];
      let release: () => void = () => {};
      let held: Promise<void>;
      let holding: () => void = () => {};

      function write(method: string, url: string, body: Record<string, unknown>): unknown {
        const path = url.slice(GITHUB.length);
        if (method === "POST" && path === "") {
          const number = 42 + issues.size;
          const labels = dropLabel ? [] : [{ name: "rig-alert" }];
          issues.set(number, {
            number,
            created_at: new Date().toISOString(),
            state: "open",
            body: body.body as string,
            user: { login: MONITOR },
            labels,
            comments: [],
          });
          return { ...issueCreated, number, title: body.title, body: body.body, labels };
        }
        const [, n, comments] = path.match(/^\/(\d+)(\/comments)?$/)!;
        const issue = issues.get(Number(n))!;
        if (comments) {
          issue.comments.push({ body: body.body as string, user: { login: MONITOR } });
          return commentCreated;
        }
        if (typeof body.state === "string") issue.state = body.state;
        return { ...issueCreated, number: issue.number, state: issue.state };
      }

      function read(url: string): unknown {
        const path = url.slice(GITHUB.length);
        // Every list fits on its first page here; the paging itself is unit-tested.
        const firstPage = new URL(url).searchParams.get("page") === "1";
        if (path.startsWith("?")) return firstPage ? [...issues.values()].reverse().map((i) => ({ ...issueCreated, ...i })) : [];
        const [, n, comments] = path.match(/^\/(\d+)(\/comments)?(\?.*)?$/)!;
        const issue = issues.get(Number(n))!;
        if (comments) return firstPage ? issue.comments : [];
        return { ...issueCreated, number: issue.number, state: issue.state };
      }

      beforeEach(() => {
        issues = new Map();
        dropLabel = false;
        calls = [];
        reads = [];
        githubAnswers = [];
        held = new Promise((resolve) => (holding = resolve));
        vi.stubEnv("GITHUB_RIG_ALERT_TOKEN", TOKEN);
        const others = globalThis.fetch;
        vi.stubGlobal(
          "fetch",
          vi.fn(async (url: string, init: RequestInit) => {
            if (url === "https://api.github.com/user") return Response.json({ login: MONITOR });
            if (!url.startsWith(GITHUB)) return others(url, init);
            const method = init.method ?? "GET";
            if (method === "GET") {
              reads.push(url);
              return Response.json(read(url), { status: 200 });
            }
            const body = JSON.parse(init.body as string) as Record<string, unknown>;
            const answer = githubAnswers.shift() ?? (method === "POST" ? 201 : 200);
            if (answer === "echo") {
              return new Response(`upstream echoed ${TOKEN} ${JSON.stringify(body)}`, { status: 502 });
            }
            if (typeof answer === "number" && answer >= 300) return Response.json({ message: "Server Error" }, { status: answer });
            if (answer === "hold") {
              holding();
              await new Promise<void>((resolve) => (release = resolve));
            }
            calls.push({ method, url, body });
            const result = write(method, url, body);
            if (answer === "lost") throw new DOMException("timed out", "TimeoutError");
            return Response.json(result, { status: answer === "hold" ? 201 : answer });
          }),
        );
      });

      async function issueNumbers() {
        const { rows } = await testDb().query<{ n: number | null }>(
          "select github_issue_number as n from monitor_alerts order by id",
        );
        return rows.map((r) => r.n);
      }

      /** The rig heartbeats again, and two evaluations resolve its alert. */
      async function recover(rig: SeededRig) {
        await heartbeat(rig, 0);
        await nextEvaluation();
        await nextEvaluation();
      }

      /** And goes silent again: its latest heartbeat is the 3-minute-old one once more. */
      async function silentAgain(rig: SeededRig) {
        await testDb().query("delete from rig_heartbeats where received_at > now() - interval '60 seconds'");
        await testDb().query("update rigs set last_seen_at = now() - interval '180 seconds' where id = $1", [rig.id]);
      }

      it("opens one issue when the diagnosis says software, comments a re-fire and a recovery, and never closes it", async () => {
        const rig = await seatedSilentRig();
        geminiAnswers = ["answer", "answer"];

        await nextEvaluation();
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe(GITHUB);
        expect(calls[0]!.body).toMatchObject({
          title: "[rig-alert] Rig silent - Rig 2",
          labels: ["rig-alert"],
        });
        const body = calls[0]!.body.body as string;
        expect(body).toMatch(/```text\nOasis rig alert #\d+ - rule 1: Rig silent \(Rig 2\)\n/);
        expect(body).toContain("<details><summary>Latest heartbeats (allowlisted fields, oldest first)</summary>");
        expect(body).not.toContain("Matt G");
        expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
        expect(await issueNumbers()).toEqual([42]);

        // Nothing more while it stays open.
        await nextEvaluation();
        expect(calls).toHaveLength(1);

        await recover(rig);
        expect(calls).toHaveLength(2);
        expect(calls[1]!.url).toBe(`${GITHUB}/42/comments`);
        expect(calls[1]!.body.body).toMatch(
          /^Every rig on this issue has recovered: alert \d+ \(Rig 2\) after \d+ s\. The issue stays open/,
        );

        // The same rule within a day: a comment, not a second issue.
        await silentAgain(rig);
        await nextEvaluation();
        expect(calls).toHaveLength(3);
        expect(calls[2]!.url).toBe(`${GITHUB}/42/comments`);
        expect(calls[2]!.body.body).toMatch(/^Fired again as alert \d+ \(Rig 2\)\.\n\n```text\nOasis rig alert #/);
        expect(await issueNumbers()).toEqual([42, 42]);

        // The open issue was read, not reopened; every call filed or commented, none closed anything.
        expect(reads.filter((url) => url === `${GITHUB}/42`)).toHaveLength(1);
        expect(calls.every((c) => c.method === "POST" && !("state" in c.body))).toBe(true);
      });

      it("reopens the issue a re-fire comments on when it was closed", async () => {
        const rig = await seatedSilentRig();
        geminiAnswers = ["answer", "answer"];

        await nextEvaluation();
        await recover(rig);
        expect(calls).toHaveLength(2);

        issues.get(42)!.state = "closed";
        await silentAgain(rig);
        await nextEvaluation();
        expect(calls.slice(2)).toMatchObject([
          { method: "PATCH", url: `${GITHUB}/42`, body: { state: "open" } },
          { method: "POST", url: `${GITHUB}/42/comments`, body: { body: expect.stringMatching(/^Fired again as alert \d+ \(Rig 2\)\./) } },
        ]);
        expect(issues.get(42)!.state).toBe("open");
        expect(await issueNumbers()).toEqual([42, 42]);
      });

      it("files a refused issue's retry with only the heartbeats its handoff was written from", async () => {
        const rig = await seatedSilentRig();
        geminiAnswers = ["answer"];
        githubAnswers = [500];

        await nextEvaluation();
        const { rows } = await testDb().query<{ at: string }>("select diagnosis->>'at' as at from monitor_alerts");
        const handoffAt = Date.parse(rows[0]!.at);
        await heartbeat(rig, 0, { agentVersion: "9.9.9" });
        await testDb().query(
          "update monitor_alerts set diagnosis = diagnosis || jsonb_build_object('issueAttemptedAt', now() - interval '90 seconds')",
        );
        await nextEvaluation();

        const body = calls[0]!.body.body as string;
        const heartbeats = JSON.parse(body.match(/```json\n([\s\S]*?)\n```/)![1]!) as Array<{ receivedAt: number }>;
        expect(heartbeats.length).toBeGreaterThan(0);
        expect(heartbeats.every((h) => h.receivedAt <= handoffAt)).toBe(true);
        expect(body).not.toContain("9.9.9");
      });

      it("retries an issue GitHub refused on a later evaluation, once", async () => {
        await seatedSilentRig();
        geminiAnswers = ["answer"];
        githubAnswers = [500];

        await nextEvaluation();
        expect(await issueNumbers()).toEqual([null]);
        await nextEvaluation();
        expect(calls).toHaveLength(0);

        await testDb().query(
          "update monitor_alerts set diagnosis = diagnosis || jsonb_build_object('issueAttemptedAt', now() - interval '90 seconds')",
        );
        await nextEvaluation();
        await nextEvaluation();
        expect(calls).toHaveLength(1);
        expect(await issueNumbers()).toEqual([42]);
      });

      /** Makes a refused issue due for its retry now. */
      async function retryDue() {
        await testDb().query(
          "update monitor_alerts set diagnosis = diagnosis || jsonb_build_object('issueAttemptedAt', now() - interval '90 seconds') where github_issue_number is null",
        );
      }

      it("files one issue naming both when a refused alert's retry and its re-fire are filed together", async () => {
        const rig = await seatedSilentRig();
        geminiAnswers = ["answer", "answer"];
        githubAnswers = [500];

        await nextEvaluation();
        await recover(rig);
        await silentAgain(rig);
        await retryDue();
        await nextEvaluation();

        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe(GITHUB);
        expect(calls[0]!.body.body).toMatch(/^Filed by the rig monitor for alert \d+ \(Rig 2\), alert \d+ \(Rig 2\)\./);
        expect(await issueNumbers()).toEqual([42, 42]);
      });

      it("comments a refused alert's retry on the issue its later re-fire opened", async () => {
        const rig = await seatedSilentRig();
        geminiAnswers = ["answer", "answer"];
        githubAnswers = [500];

        await nextEvaluation();
        await recover(rig);
        await silentAgain(rig);
        await nextEvaluation();
        expect(await issueNumbers()).toEqual([null, 42]);

        await retryDue();
        await nextEvaluation();
        expect(calls.filter((c) => c.url === GITHUB)).toHaveLength(1);
        expect(calls[1]!.url).toBe(`${GITHUB}/42/comments`);
        expect(calls[1]!.body.body).toMatch(/^Fired again as alert \d+ \(Rig 2\)\./);
        expect(await issueNumbers()).toEqual([42, 42]);
      });

      it("records an issue whose create landed but whose answer was lost, instead of filing it again", async () => {
        await seatedSilentRig();
        geminiAnswers = ["answer"];
        githubAnswers = ["lost"];

        await nextEvaluation();
        expect(issues.size).toBe(1);
        expect(await issueNumbers()).toEqual([null]);

        await retryDue();
        await nextEvaluation();
        expect(calls.filter((c) => c.url === GITHUB)).toHaveLength(1);
        expect(issues.size).toBe(1);
        expect(await issueNumbers()).toEqual([42]);
      });

      it("never repeats a recovery or re-fire comment whose answer was lost", async () => {
        const rig = await seatedSilentRig();
        geminiAnswers = ["answer", "answer"];

        await nextEvaluation();
        githubAnswers = ["lost"];
        await recover(rig);
        expect(issues.get(42)!.comments).toHaveLength(1);
        await testDb().query(
          "update monitor_alerts set diagnosis = diagnosis || jsonb_build_object('issueRecoveryAttemptedAt', now() - interval '90 seconds')",
        );
        await nextEvaluation();
        expect(issues.get(42)!.comments).toHaveLength(1);
        const { rows } = await testDb().query<{ done: boolean }>(
          "select diagnosis ? 'issueRecoveryCommentedAt' as done from monitor_alerts",
        );
        expect(rows).toEqual([{ done: true }]);

        githubAnswers = ["lost"];
        await silentAgain(rig);
        await nextEvaluation();
        expect(issues.get(42)!.comments).toHaveLength(2);
        expect(await issueNumbers()).toEqual([42, null]);
        await retryDue();
        await nextEvaluation();
        expect(issues.get(42)!.comments).toHaveLength(2);
        expect(issues.size).toBe(1);
        expect(await issueNumbers()).toEqual([42, 42]);
      });

      it("files its own issue when a stranger's issue carries the alert's exact marker", async () => {
        await seatedSilentRig();
        geminiAnswers = ["answer"];
        githubAnswers = [500];
        await nextEvaluation();
        const { rows } = await testDb().query<{ id: string }>("select id::text from monitor_alerts");
        issues.set(7, {
          number: 7,
          created_at: new Date().toISOString(),
          state: "open",
          body: `please fix\n\n${rigAlertMarker("issue", "rig_silent", [rows[0]!.id])}`,
          user: { login: "someone-else" },
          labels: [{ name: "rig-alert" }],
          comments: [],
        });

        await retryDue();
        await nextEvaluation();
        expect(calls.filter((c) => c.url === GITHUB)).toHaveLength(1);
        expect(await issueNumbers()).toEqual([43]);
      });

      it("records a re-fire comment that landed and leaves the issue closed since then alone", async () => {
        const rig = await seatedSilentRig();
        geminiAnswers = ["answer", "answer"];
        await nextEvaluation();
        await recover(rig);
        githubAnswers = ["lost"];
        await silentAgain(rig);
        await nextEvaluation();
        expect(await issueNumbers()).toEqual([42, null]);

        // The owner closes the issue before the retry.
        issues.get(42)!.state = "closed";
        await retryDue();
        await nextEvaluation();
        expect(await issueNumbers()).toEqual([42, 42]);
        expect(issues.get(42)!.state).toBe("closed");
        expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
        expect(issues.get(42)!.comments.filter((c) => c.body.startsWith("Fired again"))).toHaveLength(1);
      });

      it("warns when the issue it finds by marker was filed without the label", async () => {
        await seatedSilentRig();
        geminiAnswers = ["answer"];
        dropLabel = true;
        githubAnswers = ["lost"];
        await nextEvaluation();
        expect(await issueNumbers()).toEqual([null]);

        await retryDue();
        await nextEvaluation();
        expect(await issueNumbers()).toEqual([42]);
        expect(issues.size).toBe(1);
        const logged = consoleError.mock.calls.map((args: unknown[]) => args.join(" ")).join("\n");
        expect(logged).toContain("issue #42 for alert");
        expect(logged).toContain("without the rig-alert label");
      });

      it("files one issue when two rigs' alerts of one rule are filed by concurrent runs", async () => {
        await seatedSilentRig(2, "Matt G");
        await seatedSilentRig(7, "Ana R");
        geminiAnswers = ["answer", "answer"];
        // Both alerts' first filing is refused, so neither has an issue.
        githubAnswers = [500];
        await nextEvaluation();
        expect(await issueNumbers()).toEqual([null, null]);

        // The first run takes the older alert and stalls inside its create...
        const { rows } = await testDb().query<{ id: string }>("select id::text from monitor_alerts order by id");
        const [older, newer] = rows.map((r) => r.id);
        const due = (id: string) =>
          testDb().query(
            "update monitor_alerts set diagnosis = diagnosis || jsonb_build_object('issueAttemptedAt', now() - interval '90 seconds') where id = $1",
            [id],
          );
        await due(older!);
        githubAnswers = ["hold"];
        const first = runDiagnoses();
        await held;
        // ...while a second run takes the other rig's.
        await due(newer!);
        await runDiagnoses();
        release();
        await first;

        expect(calls.filter((c) => c.url === GITHUB)).toHaveLength(1);
        expect(await issueNumbers()).toEqual([42, null]);
        await retryDue();
        await runDiagnoses();
        expect(issues.size).toBe(1);
        const bodies = issues.get(42)!.comments.map((c) => c.body);
        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toMatch(/^Fired again as alert \d+ \(Rig 7\)\./);
        expect(await issueNumbers()).toEqual([42, 42]);
      });

      it("files one issue for a rule firing on twenty rigs, one comment per pass, and one recovery once all recover", async () => {
        const rigs: SeededRig[] = [];
        for (let n = 1; n <= 20; n++) rigs.push(await seatedSilentRig(n, `Driver ${n}`));
        geminiAnswers = Array.from({ length: 20 }, () => "answer" as const);

        let passes = 0;
        const filed = async () => (await issueNumbers()).filter((n) => n !== null).length;
        while ((await filed()) < 20 && passes < 20) {
          await nextEvaluation();
          passes++;
        }
        expect(await issueNumbers()).toEqual(Array.from({ length: 20 }, () => 42));
        expect(issues.size).toBe(1);
        const issue = issues.get(42)!;
        const refires = issue.comments.filter((c) => c.body.startsWith("Fired again"));
        expect(refires.length).toBeLessThanOrEqual(passes - 1);
        expect(refires.length).toBeLessThan(19);
        // Every rig is named once, in the issue or the comment of the pass it joined in.
        const named = [issue.body, ...refires.map((c) => c.body)].flatMap((b) => b.split("\n")[0]!.match(/\(Rig \d+\)/g) ?? []);
        expect(named).toHaveLength(20);
        expect(new Set(named).size).toBe(20);

        // Nineteen recover: the issue says nothing while one rig is still down.
        const recoveries = () => issue.comments.filter((c) => c.body.startsWith("Every rig on this issue has recovered"));
        for (const rig of rigs.slice(0, 19)) await heartbeat(rig, 0);
        await nextEvaluation();
        await nextEvaluation();
        expect(recoveries()).toHaveLength(0);

        await recover(rigs[19]!);
        expect(recoveries()).toHaveLength(1);
        expect(recoveries()[0]!.body.split("\n")[0]!.match(/\(Rig \d+\)/g)).toHaveLength(20);
        await nextEvaluation();
        expect(recoveries()).toHaveLength(1);
        expect(issues.size).toBe(1);
        expect(calls.every((c) => !("state" in c.body))).toBe(true);
      });

      it("logs only the status when GitHub's error body echoes the token and the issue", async () => {
        await seatedSilentRig();
        geminiAnswers = ["answer"];
        githubAnswers = ["echo"];

        await nextEvaluation();
        const logged = consoleError.mock.calls.map((args: unknown[]) => args.join(" ")).join("\n");
        expect(logged).toContain("HTTP 502");
        expect(logged).not.toContain(TOKEN);
        expect(logged).not.toContain("rig-alert]");
        expect(logged).not.toContain("Oasis rig alert");
      });

      it("opens no issue when neither the rule nor the diagnosis says software", async () => {
        await seatedSilentRig();
        const text = geminiAnswer.candidates[0]!.content.parts[0]!.text.replace('"software"', '"operational"');
        const operational = structuredClone(geminiAnswer);
        operational.candidates[0]!.content.parts[0]!.text = text;
        const gemini = globalThis.fetch;
        vi.stubGlobal(
          "fetch",
          vi.fn(async (url: string, init: RequestInit) =>
            url.startsWith("https://generativelanguage.googleapis.com/") ? Response.json(operational) : gemini(url, init),
          ),
        );

        await nextEvaluation();
        expect(posts).toHaveLength(3);
        expect(calls).toHaveLength(0);
        expect(await issueNumbers()).toEqual([null]);
      });

      it("files nothing without a token, and Discord still gets the alert, diagnosis and handoff", async () => {
        vi.stubEnv("GITHUB_RIG_ALERT_TOKEN", "");
        await seatedSilentRig();
        geminiAnswers = ["answer"];

        await nextEvaluation();
        await nextEvaluation();
        expect(calls).toHaveLength(0);
        expect(posts).toHaveLength(3);
        expect(posts[2]!.content).toMatch(/^```text\nOasis rig alert #/);
        expect(await issueNumbers()).toEqual([null]);
      });
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
