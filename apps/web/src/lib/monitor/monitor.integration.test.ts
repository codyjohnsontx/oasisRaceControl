import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { CURRENT_AGENT_VERSION } from "./agent-version";
import { flowModel } from "./flow";
import geminiAnswer from "./diagnosis/fixtures/gemini-generate-content.json";
import commentCreated from "./fixtures/github-comment-created.json";
import issueCreated from "./fixtures/github-issue-created.json";
import { markedAlerts, rigAlertMarker } from "./handoff";
import { runDiagnoses, runMonitor } from "./run";
import { openingMessage } from "./messages";
import {
  alertsById,
  applyFindings,
  claimAnnounceRetries,
  claimDiagnoses,
  claimEvaluation,
  LAP_BESTS_SQL,
  lastLapAtByRig,
  loadSnapshot,
  markAnnounced,
  monitorClock,
  nextVenueMidnightSql,
  RECENT_LAPS_SQL,
  recentAlerts,
  type OpenAlert,
} from "./store";
import { rigTiles, shownFindings } from "./rig-health";
import { evaluateRules, type Finding, type Severity } from "./rules";
import {
  closeTestDb,
  describeDb,
  openAssignment,
  resetDb,
  seedDriver,
  seedRig,
  setFeaturedCombo,
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
  embeds?: Array<{ title?: string; description?: string; color?: number }>;
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
    checkout?: string;
    session?: { track: string; config: string | null; car: string };
  } = {},
) {
  // The route's column layout: the fields rules filter on have columns, the rest is payload.
  await testDb().query(
    `insert into rig_heartbeats (rig_id, received_at, sent_at, clock_skew_ms,
       process_started_at, sim_connected, telemetry_faulted, pending_laps, rejected_laps,
       checkout, shutting_down, payload, agent_version, assignment_id,
       session_track, session_config, session_car)
     values ($1, now() - make_interval(secs => $2), now() - make_interval(secs => $3), 0,
       $4, true, false, 0, $5, $10, $6, $7, $8, $9, $11, $12, $13)`,
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
      fields.checkout ?? "none",
      fields.session?.track ?? null,
      fields.session?.config ?? null,
      fields.session?.car ?? null,
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

const TRACK = { track: "Circuit of the Americas", config: "Grand Prix" };

/**
 * Stores a lap `agoS` seconds ago as the ingestion route would: owned (with
 * the assignment it was stamped with) or unattributed with a cause, valid or
 * refused with a reason.
 */
async function storeLap(
  rig: SeededRig,
  agoS: number,
  lap: {
    owner?: { driverId: string; assignmentId: string };
    cause?: string;
    invalidReason?: string;
    lapTimeMs?: number;
    car?: string;
  } = {},
): Promise<string> {
  const invalidReason = lap.owner ? (lap.invalidReason ?? null) : "UNATTRIBUTED";
  const { rows } = await testDb().query<{ id: string }>(
    `insert into laps (event_id, rig_id, rig_assignment_id, driver_id, track_name, track_config,
       car_name, lap_time_ms, is_valid, invalid_reason, unattributed_cause, completed_at, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       now() - make_interval(secs => $12), now() - make_interval(secs => $12))
     returning id::text`,
    [
      randomUUID(),
      rig.id,
      lap.owner?.assignmentId ?? null,
      lap.owner?.driverId ?? null,
      TRACK.track,
      TRACK.config,
      lap.car ?? "FIA F4",
      lap.lapTimeMs ?? 137_000,
      invalidReason === null,
      invalidReason,
      lap.owner ? null : (lap.cause ?? "nobody_checked_in"),
      agoS,
    ],
  );
  return rows[0]!.id;
}

/** A stint that ended long ago: somewhere to hang a lap's attribution. */
async function pastStint(rigId: string, driverId: string): Promise<string> {
  const { rows } = await testDb().query<{ id: string }>(
    `insert into rig_assignments (rig_id, driver_id, started_at, ended_at, end_reason)
     values ($1, $2, now() - interval '3 days', now() - interval '3 days' + interval '1 hour', 'driver_ended')
     returning id::text`,
    [rigId, driverId],
  );
  return rows[0]!.id;
}

/**
 * Rows a statement read from `relation`: what each scan returned plus what
 * its filter threw away, from the executor's own statistics rather than a
 * timing, so it is not flaky.
 */
function rowsRead(plan: unknown, relation: string): number {
  let total = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record["Relation Name"] === relation) {
      const loops = Number(record["Actual Loops"] ?? 1);
      total += (Number(record["Actual Rows"]) + Number(record["Rows Removed by Filter"] ?? 0)) * loops;
    }
    Object.values(record).forEach(visit);
  };
  visit(plan);
  return total;
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

/** Rule 7 on one rig, at the severity event mode would give it. */
function wrongCombo(severity: Severity): Finding {
  return {
    rule: "wrong_combo",
    subject: "rig:severity",
    severity,
    level: 0,
    detail: { headline: "Rig 01 is on the wrong car", where: "Rig 01", fields: [], driver: null },
  };
}

/** Every alert timestamp moved `minutes` into the past, as if that long had gone by. */
async function timePasses(minutes: number) {
  await testDb().query(
    `update monitor_alerts
     set opened_at = opened_at - $1::interval, last_seen_at = last_seen_at - $1::interval,
         resolved_at = resolved_at - $1::interval, notified_at = notified_at - $1::interval,
         notify_attempted_at = notify_attempted_at - $1::interval, notify_until = notify_until - $1::interval,
         recovery_notified_at = recovery_notified_at - $1::interval,
         recovery_attempted_at = recovery_attempted_at - $1::interval`,
    [`${minutes} minutes`],
  );
}

async function openAlertRows(): Promise<OpenAlert[]> {
  const { rows } = await testDb().query<OpenAlert>(
    "select id::text, rule, subject from monitor_alerts where resolved_at is null",
  );
  return rows;
}

async function severityRow() {
  const { rows } = await testDb().query<{ severity: string; notified: boolean }>(
    "select severity, notified_at is not null as notified from monitor_alerts where resolved_at is null",
  );
  return rows[0];
}

/** What the channel would show for alert `id` now, as the opening (or its retry) renders it. */
async function opening(id: string) {
  const [alert] = await alertsById([id]);
  return openingMessage(alert!, OWNER);
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
    /** "hold" answers only once `releaseModel` is called, and resolves `modelHeld` when it starts waiting. */
    let geminiAnswers: Array<"timeout" | "answer" | "hold"> = [];
    let prompts: string[] = [];
    let releaseModel: () => void = () => {};
    let holdingModel: () => void = () => {};
    let modelHeld: Promise<void>;

    beforeEach(() => {
      geminiAnswers = [];
      prompts = [];
      modelHeld = new Promise((resolve) => (holdingModel = resolve));
      vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
      vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "9b4fd5d0c0ffee");
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          if (!url.startsWith(GEMINI)) return fetchMock(url, init);
          prompts.push(init.body as string);
          // What AbortSignal.timeout() rejects with when the 20 s run out.
          const answer = geminiAnswers.shift();
          if (answer === "hold") {
            holdingModel();
            await new Promise<void>((resolve) => (releaseModel = resolve));
          } else if (answer !== "answer") {
            throw new DOMException("timed out", "TimeoutError");
          }
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
        // The current build, so rule 11 has nothing to add to the three posts.
        await heartbeat(rig, ago, { agentVersion: CURRENT_AGENT_VERSION, assignmentId });
      }
      geminiAnswers = ["answer"];

      await nextEvaluation();

      expect(posts).toHaveLength(3);
      const handoff = posts[2]!.content!;
      expect(handoff).toContain(`· agent ${CURRENT_AGENT_VERSION}\n`);
      expect(handoff).toMatch(/Rig state \(last 3 heartbeats\): \d\d:\d\d:\d\d, sim connected, pending 0, skew \+0\.0 s;/);
      const heartbeats = JSON.parse(prompts[0]!).contents[0].parts[0].text;
      expect(heartbeats).toContain(`"agentVersion": "${CURRENT_AGENT_VERSION}"`);
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
          /^Everything on this issue has recovered: alert \d+ \(Rig 2\) after \d+ s\. The issue stays open/,
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

      it("reconciles lost writes when the seated driver is named after the rule key", async () => {
        const rig = await seatedSilentRig(2, "rig_silent");
        geminiAnswers = ["answer", "answer"];
        githubAnswers = ["lost"];
        await nextEvaluation();
        expect(issues.size).toBe(1);

        // The marker names the rule the lock and re-fire lookup use, not the driver's stand-in.
        const trailer = (body: string) => body.trimEnd().split("\n").at(-1)!;
        const { rows } = await testDb().query<{ id: string; rule: string }>("select id::text, rule from monitor_alerts");
        expect(rows[0]!.rule).toBe("rig_silent");
        expect(markedAlerts(trailer(issues.get(42)!.body), "issue", rows[0]!.rule)).toEqual([rows[0]!.id]);

        await retryDue();
        await nextEvaluation();
        expect(issues.size).toBe(1);
        expect(await issueNumbers()).toEqual([42]);

        await recover(rig);
        githubAnswers = ["lost"];
        await silentAgain(rig);
        await nextEvaluation();
        await retryDue();
        await nextEvaluation();
        const refires = issues.get(42)!.comments.filter((c) => c.body.startsWith("Fired again"));
        expect(refires).toHaveLength(1);
        expect(markedAlerts(trailer(refires[0]!.body), "refire", "rig_silent")).toHaveLength(1);
        expect(issues.size).toBe(1);
        expect(await issueNumbers()).toEqual([42, 42]);
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

      it("never announces as a re-fire the alert whose lost create another rig's alert adopted", async () => {
        await seatedSilentRig(2, "Matt G");
        geminiAnswers = ["answer", "answer"];
        githubAnswers = ["lost"];
        await nextEvaluation();
        expect(issues.size).toBe(1);
        expect(await issueNumbers()).toEqual([null]);

        // Another rig's alert of the rule is filed before the first one's retry is due.
        await seatedSilentRig(7, "Ana R");
        await nextEvaluation();
        expect(await issueNumbers()).toEqual([42, 42]);

        await retryDue();
        await nextEvaluation();
        expect(issues.size).toBe(1);
        const refires = issues.get(42)!.comments.filter((c) => c.body.startsWith("Fired again"));
        expect(refires.map((c) => c.body.split("\n")[0])).toEqual([expect.stringMatching(/^Fired again as alert \d+ \(Rig 7\)\.$/)]);
      });

      it("says nothing of recovery while another rig's alert of the rule is still to be filed", async () => {
        const first = await seatedSilentRig(2, "Matt G");
        geminiAnswers = ["answer"];
        await nextEvaluation();
        expect(await issueNumbers()).toEqual([42]);

        // The second rig's diagnosis times out, so its alert waits for a retry while the first recovers.
        const second = await seatedSilentRig(7, "Ana R");
        await recover(first);
        expect(await issueNumbers()).toEqual([42, null]);
        const recoveries = () =>
          issues.get(42)!.comments.filter((c) => c.body.startsWith("Everything on this issue has recovered"));
        expect(recoveries()).toHaveLength(0);

        geminiAnswers = ["answer"];
        await age(90);
        await nextEvaluation();
        expect(await issueNumbers()).toEqual([42, 42]);
        await recover(second);
        expect(recoveries()).toHaveLength(1);
        expect(recoveries()[0]!.body.split("\n")[0]!.match(/\(Rig \d+\)/g)).toEqual(["(Rig 2)", "(Rig 7)"]);
      });

      it("holds the recovery for an alert whose filing waits, though its rig recovered first", async () => {
        const first = await seatedSilentRig(2, "Matt G");
        geminiAnswers = ["answer", "answer"];
        await nextEvaluation();
        expect(await issueNumbers()).toEqual([42]);

        // The second rig's alert is diagnosed, but GitHub refuses its re-fire comment.
        const second = await seatedSilentRig(7, "Ana R");
        githubAnswers = [500];
        await nextEvaluation();
        expect(await issueNumbers()).toEqual([42, null]);

        // Every rig recovers before the refused filing is retried.
        await heartbeat(first, 0);
        await heartbeat(second, 0);
        await nextEvaluation();
        await nextEvaluation();
        expect((await alerts()).every((a) => a.resolved)).toBe(true);
        const comments = () => issues.get(42)!.comments.map((c) => c.body);
        const recoveries = () => comments().filter((b) => b.startsWith("Everything on this issue has recovered"));
        expect(recoveries()).toHaveLength(0);

        await retryDue();
        await nextEvaluation();
        await nextEvaluation();
        expect(await issueNumbers()).toEqual([42, 42]);
        expect(recoveries()).toHaveLength(1);
        expect(recoveries()[0]!.split("\n")[0]!.match(/\(Rig \d+\)/g)).toEqual(["(Rig 2)", "(Rig 7)"]);
        expect(comments().at(-1)).toBe(recoveries()[0]);
        expect(comments().filter((b) => b.startsWith("Fired again"))).toHaveLength(1);
      });

      it("holds the recovery for an alert whose rig recovered while its diagnosis was in flight", async () => {
        const first = await seatedSilentRig(2, "Matt G");
        geminiAnswers = ["answer"];
        await nextEvaluation();
        expect(await issueNumbers()).toEqual([42]);

        // The second rig's diagnosis call is still running...
        const second = await seatedSilentRig(7, "Ana R");
        geminiAnswers = ["hold"];
        const diagnosing = nextEvaluation();
        await modelHeld;

        // ...when every rig recovers and another run looks for recoveries.
        await heartbeat(first, 0);
        await heartbeat(second, 0);
        await nextEvaluation();
        await nextEvaluation();
        expect((await alerts()).every((a) => a.resolved)).toBe(true);
        const comments = () => issues.get(42)!.comments.map((c) => c.body);
        const recoveries = () => comments().filter((b) => b.startsWith("Everything on this issue has recovered"));
        expect(recoveries()).toHaveLength(0);

        releaseModel();
        await diagnosing;
        await nextEvaluation();
        expect(await issueNumbers()).toEqual([42, 42]);
        expect(recoveries()).toHaveLength(1);
        expect(recoveries()[0]!.split("\n")[0]!.match(/\(Rig \d+\)/g)).toEqual(["(Rig 2)", "(Rig 7)"]);
        expect(comments().at(-1)).toBe(recoveries()[0]);
        expect(comments().filter((b) => b.startsWith("Fired again"))).toHaveLength(1);
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
        const recoveries = () => issue.comments.filter((c) => c.body.startsWith("Everything on this issue has recovered"));
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


  describe("severity that event mode changes while an alert is open", () => {
    it("raises a posted warning to urgent once, with the owner's mention", async () => {
      const [opened] = (await applyFindings(db(), [wrongCombo("warning")], [])).announce;
      await markAnnounced((await alertsById([opened!]))[0]!);

      const raised = await applyFindings(db(), [wrongCombo("urgent")], await openAlertRows());
      expect(raised.announce).toEqual([opened]);
      expect(await severityRow()).toEqual({ severity: "urgent", notified: false });
      const message = await opening(opened!);
      expect(message.content).toMatch(new RegExp(`^<@${OWNER}> 🔴 `));
      expect(message.allowed_mentions).toEqual({ parse: [], users: [OWNER] });

      await markAnnounced((await alertsById([opened!]))[0]!);
      expect((await applyFindings(db(), [wrongCombo("urgent")], await openAlertRows())).announce).toEqual([]);
    });

    it("lowers urgent to warning quietly", async () => {
      const [opened] = (await applyFindings(db(), [wrongCombo("urgent")], [])).announce;
      await markAnnounced((await alertsById([opened!]))[0]!);

      expect((await applyFindings(db(), [wrongCombo("warning")], await openAlertRows())).announce).toEqual([]);
      expect(await severityRow()).toEqual({ severity: "warning", notified: true });
    });

    it("retries an urgent post that failed as the warning it has since become: no mention, no diagnosis", async () => {
      // Opened urgent during the event; its post failed, so it was never marked.
      const [opened] = (await applyFindings(db(), [wrongCombo("urgent")], [])).announce;
      await applyFindings(db(), [wrongCombo("warning")], await openAlertRows());
      await testDb().query("update monitor_alerts set notify_attempted_at = now() - interval '2 minutes'");

      const retried = await claimAnnounceRetries();
      expect(retried.map((a) => a.id)).toEqual([opened]);
      const message = openingMessage(retried[0]!, OWNER);
      expect(message.content).toMatch(/^🟡 /);
      expect(message.allowed_mentions).toEqual({ parse: [] });
      await markAnnounced(retried[0]!);
      expect(await claimDiagnoses()).toEqual([]);
    });
  });

  it("mutes a run of implausibly fast laps on one rig: three posts, one mute line, then one summary of the muted laps", async () => {
    const rig = await seedRig(1);
    for (let i = 0; i < 5; i++) {
      const other = await seedDriver(`Other ${i}`);
      const owner = { driverId: other.id, assignmentId: await pastStint(rig.id, other.id) };
      await storeLap(rig, 3600, { owner, lapTimeMs: 120_000 + i * 1000 });
    }
    const driver = await seedDriver("Ada");
    const assignmentId = await openAssignment(rig.id, driver.id);
    await heartbeat(rig, 0);
    for (let i = 0; i < 6; i++) {
      await storeLap(rig, 300 - i * 30, { owner: { driverId: driver.id, assignmentId }, lapTimeMs: 110_000 + i });
    }

    await nextEvaluation();
    await nextEvaluation();
    await nextEvaluation();
    expect(posts.map((p) => p.content)).toEqual([
      expect.stringMatching(/^🟡 Rig 01: a 1:50\.000 lap by Ada/),
      expect.stringMatching(/^🟡 Rig 01: a 1:50\.001 lap by Ada/),
      expect.stringMatching(/^🟡 Rig 01: a 1:50\.002 lap by Ada/),
      expect.stringMatching(/^🔕 Flapping: Implausibly fast lap - Rig 01 has fired 4 times in the last hour; muted for 1 h/),
    ]);
    const { rows } = await testDb().query<{ subject: string }>("select subject from monitor_alerts order by id");
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.subject)).size).toBe(6);
    expect(rows.every((r) => r.subject.startsWith(`rig:${rig.id}|lap:`))).toBe(true);

    // The hour passes and the laps leave the monitor's view, closing every
    // alert quietly. The summary's first post is refused and a later
    // evaluation posts it, once.
    posts = [];
    await setFeaturedCombo({ trackName: TRACK.track, trackConfig: TRACK.config, carName: "FIA F4" });
    await testDb().query(
      "update laps set created_at = created_at - interval '61 minutes', completed_at = completed_at - interval '61 minutes'",
    );
    await timePasses(61);
    discordAnswers = [500];
    await nextEvaluation();
    await nextEvaluation();
    expect(posts).toEqual([]);
    expect((await alerts()).every((a) => a.resolved)).toBe(true);

    await timePasses(2);
    await nextEvaluation();
    await timePasses(2);
    await nextEvaluation();
    expect(posts).toEqual([
      {
        content:
          "🟡 Rig 01: 3 laps flagged as implausibly fast while the rule was muted, on today's featured combo " +
          "(Circuit of the Americas Grand Prix · FIA F4) - worth a look; they rank unless staff invalidate them",
        embeds: [
          {
            title: "Implausibly fast lap",
            color: 0xf1c40f,
            description: [
              "• Rig 01 · 1:50.003 by Ada",
              "• Rig 01 · 1:50.004 by Ada",
              "• Rig 01 · 1:50.005 by Ada",
            ].join("\n"),
            footer: { text: expect.stringMatching(/^alert #\d+ · rule 14$/) },
          },
        ],
        allowed_mentions: { parse: [] },
      },
    ]);
  });

  it("posts a long fast-lap summary in parts, and resumes a refused one at the lap Discord did not take, though the combo changed", async () => {
    const rig = await seedRig(1);
    for (let i = 0; i < 5; i++) {
      const other = await seedDriver(`Other ${i}`);
      const owner = { driverId: other.id, assignmentId: await pastStint(rig.id, other.id) };
      await storeLap(rig, 3600, { owner, lapTimeMs: 120_000 + i * 1000 });
    }
    const driver = await seedDriver("Ada");
    const assignmentId = await openAssignment(rig.id, driver.id);
    await heartbeat(rig, 0);
    for (let i = 0; i < 120; i++) {
      await storeLap(rig, 600 - i * 4, { owner: { driverId: driver.id, assignmentId }, lapTimeMs: 110_000 + i });
    }
    await nextEvaluation();
    expect(posts).toHaveLength(4);

    posts = [];
    await setFeaturedCombo({ trackName: TRACK.track, trackConfig: TRACK.config, carName: "FIA F4" });
    await testDb().query(
      "update laps set created_at = created_at - interval '61 minutes', completed_at = completed_at - interval '61 minutes'",
    );
    await timePasses(61);
    discordAnswers = [204, 500];
    await nextEvaluation();
    expect(posts.map((p) => p.content)).toEqual([expect.stringMatching(/ \(part 1 of 3\)$/)]);

    // Staff change today's combo before the retry: the parts still to post
    // read differently, and must still pick up at lap 29.
    await setFeaturedCombo({ trackName: TRACK.track, trackConfig: TRACK.config, carName: "Mazda MX-5" });
    await nextEvaluation();
    await timePasses(2);
    await nextEvaluation();
    await timePasses(2);
    await nextEvaluation();
    expect(posts.map((p) => p.content)).toEqual([
      expect.stringMatching(/^🟡 Rig 01: 117 laps flagged .*, on today's featured combo .* \(part 1 of 3\)$/),
      expect.stringMatching(/, on another car and track - .* \(part 2 of 3\)$/),
      expect.stringMatching(/, on another car and track - .* \(part 3 of 3\)$/),
    ]);
    const listed = posts.flatMap((p) => (p.embeds as Array<{ description: string }>)[0]!.description.split("\n"));
    expect(listed.pop()).toBe("and 42 more implausible laps on Rig 01 this hour");
    expect(listed).toEqual(Array.from({ length: 75 }, (_, i) => `• Rig 01 · 1:50.${String(i + 3).padStart(3, "0")} by Ada`));

    await timePasses(2);
    await nextEvaluation();
    expect(posts).toHaveLength(3);
    const { rows } = await testDb().query<{ done: boolean }>(
      "select recovery_notified_at is not null as done from monitor_alerts where refire_count >= 3 order by id limit 1",
    );
    expect(rows).toEqual([{ done: true }]);
  });

  describe("flapping", () => {
    /** Rule 16 opens on one heartbeat and clears two evaluations after the next. */
    async function flap(rig: SeededRig) {
      await heartbeat(rig, 0, { checkout: "not_queued" });
      await nextEvaluation();
      await heartbeat(rig, 0);
      await nextEvaluation();
      await nextEvaluation();
    }

    it("mutes a rule that re-fires three times in an hour with one line, then posts nothing on it for the hour", async () => {
      const rig = await seedRig(1);
      for (let i = 0; i < 6; i++) await flap(rig);

      const opened = /^🟡 Rig 01: a sign-out could not be saved on the rig/;
      const recovered = /^🟢 Recovered: Sign-out not saved - Rig 01/;
      expect(posts.map((p) => p.content)).toEqual([
        expect.stringMatching(opened),
        expect.stringMatching(recovered),
        expect.stringMatching(opened),
        expect.stringMatching(recovered),
        expect.stringMatching(opened),
        expect.stringMatching(recovered),
        expect.stringMatching(
          /^🔕 Flapping: Sign-out not saved - Rig 01 has fired 4 times in the last hour; muted for 1 h \(alert #4 · rule 16\)$/,
        ),
      ]);
      expect(posts.at(-1)!.allowed_mentions).toEqual({ parse: [] });
      const { rows } = await testDb().query<{ refire_count: number; resolved: boolean }>(
        "select refire_count, resolved_at is not null as resolved from monitor_alerts order by id",
      );
      expect(rows.map((r) => r.refire_count)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(rows.every((r) => r.resolved)).toBe(true);
    });

    it("holds a rise to urgent while muted, and posts it, with the mention, when the mute ends", async () => {
      for (let i = 0; i < 3; i++) {
        const [opened] = (await applyFindings(db(), [wrongCombo("warning")], [])).announce;
        await markAnnounced((await alertsById([opened!]))[0]!);
        await applyFindings(db(), [], await openAlertRows());
        await applyFindings(db(), [], await openAlertRows());
      }
      const [starter] = (await applyFindings(db(), [wrongCombo("warning")], [])).announce;
      const [muteLine] = await alertsById([starter!]);
      expect(openingMessage(muteLine!, OWNER).content).toMatch(/^🔕 Flapping: /);
      await markAnnounced(muteLine!);

      expect((await applyFindings(db(), [wrongCombo("urgent")], await openAlertRows())).announce).toEqual([]);
      expect(await severityRow()).toEqual({ severity: "urgent", notified: false });
      expect(await claimAnnounceRetries()).toEqual([]);

      await timePasses(62);
      const due = await claimAnnounceRetries();
      expect(due.map((a) => a.id)).toEqual([starter]);
      expect(openingMessage(due[0]!, OWNER).content).toMatch(new RegExp(`^<@${OWNER}> 🔴 `));
    });

    /** Rule 3b opens and clears three times, then opens a fourth time and stays open. */
    async function flapIntoMute(rig: SeededRig) {
      for (let i = 0; i < 3; i++) {
        await heartbeat(rig, 0, { rejectedLaps: 1 });
        await nextEvaluation();
        await heartbeat(rig, 0);
        await nextEvaluation();
        await nextEvaluation();
      }
      await heartbeat(rig, 0, { rejectedLaps: 1 });
      await nextEvaluation();
    }

    it("keeps a muted alert open and quiet through the hour, then posts it once, and its rises after that", async () => {
      const rig = await seedRig(1);
      await flapIntoMute(rig);
      await heartbeat(rig, 0, { rejectedLaps: 4 });
      await nextEvaluation();

      expect(posts.at(-1)!.content).toMatch(/^🔕 Flapping: Laps refused by the site - Rig 01 has fired 4 times/);
      expect(posts.filter((p) => p.content?.startsWith("🔕"))).toHaveLength(1);
      expect(await alerts()).toMatchObject([{}, {}, {}, { rule: "laps_refused", level: 4, resolved: false }]);

      posts = [];
      await timePasses(61);
      await heartbeat(rig, 0, { rejectedLaps: 4 });
      await nextEvaluation();
      await nextEvaluation();
      expect(posts.map((p) => p.content)).toEqual([
        `<@${OWNER}> 🔴 Rig 01: the site refused 4 laps; they are parked on the rig`,
      ]);

      posts = [];
      await timePasses(120);
      await heartbeat(rig, 0, { rejectedLaps: 20 });
      await nextEvaluation();
      expect(posts.map((p) => p.content)).toEqual([
        `<@${OWNER}> 🔴 Rig 01: the site refused 20 laps; they are parked on the rig`,
      ]);
    });

    it("says Recovered once when a muted alert clears hours after the mute line", async () => {
      const rig = await seedRig(1);
      await flapIntoMute(rig);
      await timePasses(61);
      await heartbeat(rig, 0, { rejectedLaps: 1 });
      await nextEvaluation();
      await timePasses(120);
      posts = [];

      await heartbeat(rig, 0);
      for (let i = 0; i < 4; i++) await nextEvaluation();
      expect(posts.map((p) => p.content)).toEqual([
        expect.stringMatching(/^🟢 Recovered: Laps refused by the site - Rig 01 \(alert #4, after 3 h/),
      ]);
    });

    it("keeps an opening late in the mute muted, rises and all, once the openings before the mute have aged out", async () => {
      const rig = await seedRig(1);
      for (let i = 0; i < 4; i++) {
        await heartbeat(rig, 0, { rejectedLaps: 1 });
        await nextEvaluation();
        await heartbeat(rig, 0);
        await nextEvaluation();
        await nextEvaluation();
      }
      await testDb().query(
        "update monitor_alerts set opened_at = opened_at - interval '61 minutes' where refire_count < 3",
      );
      posts = [];

      await heartbeat(rig, 0, { rejectedLaps: 1 });
      await nextEvaluation();
      await heartbeat(rig, 0, { rejectedLaps: 4 });
      await nextEvaluation();

      expect(posts).toEqual([]);
      const { rows } = await testDb().query<{ refire_count: number; level: number; resolved: boolean }>(
        "select refire_count, level, resolved_at is not null as resolved from monitor_alerts order by id desc limit 1",
      );
      expect(rows).toEqual([{ refire_count: 3, level: 4, resolved: false }]);

      // The mute ends: the one opened inside it and still open posts its opening
      // then, and the one that closed inside it stays unposted.
      await timePasses(61);
      await heartbeat(rig, 0, { rejectedLaps: 4 });
      await nextEvaluation();
      expect(posts.map((p) => p.content)).toEqual([
        `<@${OWNER}> 🔴 Rig 01: the site refused 4 laps; they are parked on the rig`,
      ]);
    });

    it("counts only the last hour: once the mute has passed, the rule posts again", async () => {
      const rig = await seedRig(1);
      for (let i = 0; i < 4; i++) await flap(rig);
      await timePasses(61);
      posts = [];

      await flap(rig);
      expect(posts.map((p) => p.content)).toEqual([
        expect.stringMatching(/^🟡 Rig 01: a sign-out could not be saved/),
        expect.stringMatching(/^🟢 Recovered: Sign-out not saved/),
      ]);
    });

    it("diagnoses a muted urgent alert only once its mute has ended and it is posted", async () => {
      vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
      const calls: string[] = [];
      let modelAnswers = false;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          if (!url.includes("generativelanguage")) return fetchMock(url, init);
          calls.push(url);
          if (!modelAnswers) throw new DOMException("timed out", "TimeoutError");
          return Response.json(geminiAnswer);
        }),
      );
      const rig = await seedRig(1);

      // One call for each of the three openings before the mute; none for the
      // one that posted the mute line, however long it stays open inside it.
      await flapIntoMute(rig);
      await heartbeat(rig, 0, { rejectedLaps: 1 });
      await nextEvaluation();
      expect(calls).toHaveLength(3);

      // The alert goes out when the mute ends and is diagnosed then; Discord
      // refuses the diagnosis, and a later evaluation posts it with the handoff.
      await timePasses(61);
      posts = [];
      modelAnswers = true;
      discordAnswers = [204, 500];
      await heartbeat(rig, 0, { rejectedLaps: 1 });
      await nextEvaluation();
      expect(posts.map((p) => p.content)).toEqual([
        `<@${OWNER}> 🔴 Rig 01: the site refused 1 lap; it is parked on the rig`,
      ]);
      expect(calls).toHaveLength(4);

      await testDb().query(
        `update monitor_alerts set diagnosis = diagnosis || jsonb_build_object('postAttemptedAt', now() - interval '90 seconds')
         where diagnosis->>'status' = 'done'`,
      );
      await nextEvaluation();
      expect(posts).toHaveLength(3);
      expect(posts[2]!.content).toMatch(/^```text\nOasis rig alert #4/);
      expect(calls).toHaveLength(4);
    });
  });

  describe("rules read from laps, stints and the combo", () => {
    it("warns about laps landing with nobody signed in, and clears when an attributed lap lands", async () => {
      const rig = await seedRig(1);
      await heartbeat(rig, 0);
      await storeLap(rig, 300);
      await storeLap(rig, 120);

      await nextEvaluation();
      expect(posts.map((p) => p.content)).toEqual([
        "🟡 Rig 01: 2 laps in the last 10 min landed with nobody signed in - they will not rank; laps rank again once someone signs in on the rig",
      ]);

      const driver = await seedDriver("Ada");
      const assignmentId = await openAssignment(rig.id, driver.id);
      await storeLap(rig, 0, { owner: { driverId: driver.id, assignmentId } });
      await nextEvaluation();
      await nextEvaluation();
      expect(posts.at(-1)!.content).toMatch(/^🟢 Recovered: Laps with nobody signed in - Rig 01/);
    });

    it("warns about a stint past the threshold staff set in monitor_state", async () => {
      const rig = await seedRig(1);
      const driver = await seedDriver("Ada");
      const assignmentId = await openAssignment(rig.id, driver.id);
      await testDb().query("update rig_assignments set started_at = now() - interval '45 minutes' where id = $1", [
        assignmentId,
      ]);
      await heartbeat(rig, 0);

      await nextEvaluation();
      expect(posts).toEqual([]);

      await testDb().query("update monitor_state set long_stint_minutes = 30");
      await nextEvaluation();
      expect(posts.map((p) => p.content)).toEqual([
        "🟡 Rig 01: Ada has been signed in for 45 min - still driving, or a missed sign-out?",
      ]);
    });

    it("warns when a rig's last three laps were refused for today's combo, naming the combo and not the rig's strings", async () => {
      await setFeaturedCombo({ trackName: TRACK.track, trackConfig: TRACK.config, carName: "FIA F4" });
      const rig = await seedRig(1);
      const driver = await seedDriver("Ada");
      const assignmentId = await openAssignment(rig.id, driver.id);
      await heartbeat(rig, 0, { session: { ...TRACK, car: "Mazda MX-5 Cup" } });
      const owner = { driverId: driver.id, assignmentId };
      for (const agoS of [600, 400, 200]) {
        await storeLap(rig, agoS, { owner, car: "Mazda MX-5 Cup", invalidReason: "WRONG_CAR" });
      }

      await nextEvaluation();
      expect(posts.map((p) => p.content)).toEqual([
        "🟡 Rig 01 is in an iRacing session on the wrong car for today's featured combo while Ada is signed in - their laps will not rank",
      ]);
      expect(JSON.stringify(posts)).toContain("Circuit of the Americas Grand Prix · FIA F4");
      expect(JSON.stringify(posts)).not.toContain("Mazda");
    });

    it("warns when a driver moves rigs while the rig they left is still in a session", async () => {
      const [left, joined] = [await seedRig(1), await seedRig(2)];
      const driver = await seedDriver("Ada");
      const stint = await openAssignment(left.id, driver.id);
      await testDb().query(
        "update rig_assignments set ended_at = now() - interval '2 minutes', end_reason = 'moved' where id = $1",
        [stint],
      );
      await openAssignment(joined.id, driver.id);
      await heartbeat(left, 0, { session: { ...TRACK, car: "FIA F4" } });
      await heartbeat(joined, 0);
      // Today's combo is the one Rig 01 is in, so rule 4 has nothing to say.
      await testDb().query(
        `insert into featured_combos (combo_date, track_name, track_config, car_name)
         values (venue_today(), $1, $2, 'FIA F4')`,
        [TRACK.track, TRACK.config],
      );

      await nextEvaluation();
      expect(posts.map((p) => p.content)).toEqual([
        "🟡 Ada signed in on Rig 02 while still seated on Rig 01, which is still in an iRacing session - is someone driving it without signing in?",
      ]);
    });

    it("flags an implausibly fast lap without touching its validity, and closes it without a recovery", async () => {
      const rig = await seedRig(1);
      for (let i = 0; i < 5; i++) {
        const other = await seedDriver(`Other ${i}`);
        const owner = { driverId: other.id, assignmentId: await pastStint(rig.id, other.id) };
        await storeLap(rig, 3600, { owner, lapTimeMs: 120_000 + i * 1000 });
      }
      const driver = await seedDriver("Ada");
      const assignmentId = await openAssignment(rig.id, driver.id);
      await heartbeat(rig, 0);
      const fast = await storeLap(rig, 60, { owner: { driverId: driver.id, assignmentId }, lapTimeMs: 110_000 });

      await nextEvaluation();
      expect(posts.map((p) => p.content)).toEqual([
        "🟡 Rig 01: a 1:50.000 lap by Ada is 8% under the best any other driver had on this car and track (2:00.000) - worth a look; it ranks unless staff invalidate it",
      ]);
      const valid = async () =>
        (await testDb().query<{ is_valid: boolean; invalid_reason: string | null }>(
          "select is_valid, invalid_reason from laps where id = $1",
          [fast],
        )).rows[0];
      await expect(valid()).resolves.toEqual({ is_valid: true, invalid_reason: null });

      // Twenty minutes on, the lap has left the monitor's view.
      await testDb().query("update laps set created_at = created_at - interval '20 minutes', completed_at = completed_at - interval '20 minutes' where id = $1", [fast]);
      await nextEvaluation();
      await nextEvaluation();
      expect(posts).toHaveLength(1);
      expect(await alerts()).toMatchObject([{ rule: "fast_lap", resolved: true, recovery_notified: false }]);
      await expect(valid()).resolves.toEqual({ is_valid: true, invalid_reason: null });
    });

    it("reads the recent laps, and rule 14's reference for their combo only, not every lap stored", async () => {
      // Five thousand laps from the last month across fifty other cars, twenty
      // older ones on this car, and three from the last few minutes: the
      // monitor reads these every evaluation, so what it reads must not grow
      // with the lap history - only with the history of the combo being raced.
      const rig = await seedRig(1);
      const driver = await seedDriver("Ada");
      const assignmentId = await pastStint(rig.id, driver.id);
      await testDb().query(
        `insert into laps (event_id, rig_id, rig_assignment_id, driver_id, track_name, track_config,
           car_name, lap_time_ms, is_valid, completed_at, created_at)
         select gen_random_uuid()::text, $1, $2, $3, $4, $5,
                case when g <= 20 then 'FIA F4' else 'Old Car ' || (g % 50) end, 120000 + g, true,
                now() - make_interval(mins => 60 + g * 8), now() - make_interval(mins => 60 + g * 8)
         from generate_series(1, 5000) as g`,
        [rig.id, assignmentId, driver.id, TRACK.track, TRACK.config],
      );
      for (const agoS of [300, 200, 100]) await storeLap(rig, agoS, { owner: { driverId: driver.id, assignmentId } });
      await testDb().query("analyze laps");

      const explain = async (sql: string) =>
        (
          await testDb().query<{ "QUERY PLAN": unknown }>(`explain (analyze, format json) ${sql}`, [
            "1 hour",
            "900 seconds",
          ])
        ).rows[0]!["QUERY PLAN"];
      expect(rowsRead(await explain(RECENT_LAPS_SQL), "laps")).toBeLessThanOrEqual(10);
      // The three recent laps found, then this combo's twenty older ones.
      expect(rowsRead(await explain(LAP_BESTS_SQL), "laps")).toBeLessThanOrEqual(30);
    });
  });

  it("shows the Rig health page the channel's answer: a flashing red tile and the open alert", async () => {
    const rig = await seedRig(2);
    const driver = await seedDriver("Matt G");
    await openAssignment(rig.id, driver.id);
    for (const ago of [600, 540, 480, 420, 360, 300, 240, 180]) await heartbeat(rig, ago);
    await nextEvaluation();
    await testDb().query("update monitor_alerts set github_issue_number = 57");

    // What the page reads, without claiming an evaluation.
    const clock = await monitorClock(db());
    expect(clock.lastEvaluatedAt).not.toBeNull();
    expect(clock.now - clock.lastEvaluatedAt!).toBeLessThan(60_000);
    const tileNow = async () => {
      const snapshot = await loadSnapshot(db(), (await monitorClock(db())).now);
      const shown = shownFindings(evaluateRules(snapshot), snapshot.openAlerts);
      return rigTiles(snapshot, shown, await lastLapAtByRig(db()))[0]!;
    };
    const silent = "Rig 02 has been silent for 3 min with Matt G signed in";
    expect(await tileNow()).toMatchObject({
      label: "R02",
      colour: "red-flashing",
      status: "silent 3 min",
      problems: [{ severity: "urgent", headline: silent }],
    });

    expect(await recentAlerts(db())).toEqual([
      {
        id: expect.any(String),
        rule: "rig_silent",
        severity: "urgent",
        where: "Rig 02",
        headline: "Rig 02 has been silent for 3 min with Matt G signed in",
        openedAt: expect.any(Number),
        resolvedAt: null,
        muted: false,
        githubIssueNumber: 57,
      },
    ]);

    // Heard again. The rules find nothing now, but the alert stays open until
    // a second evaluation without it, and the tile says so until then.
    await heartbeat(rig, 0);
    await nextEvaluation();
    expect(await alerts()).toMatchObject([{ rule: "rig_silent", resolved: false }]);
    expect(await tileNow()).toMatchObject({
      colour: "red-flashing",
      status: "online",
      problems: [{ severity: "urgent", headline: silent }],
    });

    await nextEvaluation();
    expect(await alerts()).toMatchObject([{ rule: "rig_silent", resolved: true }]);
    expect(await tileNow()).toMatchObject({ colour: "green", problems: [] });
  });

  it("lists every open alert on the Rig health page, however many newer ones recovered", async () => {
    await testDb().query(
      `insert into monitor_alerts (rule, subject, severity, detail, opened_at, resolved_at)
       values ('agent_outdated', 'rig:old', 'warning', '{"headline": "still open"}', now() - interval '3 days', null)`,
    );
    await testDb().query(
      `insert into monitor_alerts (rule, subject, severity, detail, opened_at, resolved_at)
       select 'fast_lap', 'rig:new|' || n, 'warning', '{"headline": "recovered"}',
              now() - n * interval '1 minute', now() - n * interval '1 minute' + interval '30 seconds'
       from generate_series(1, 3) as n`,
    );

    const listed = await recentAlerts(db(), 2);
    expect(listed.map((a) => [a.headline, a.resolvedAt === null])).toEqual([
      ["still open", true],
      ["recovered", false],
      ["recovered", false],
    ]);
    expect(listed[1]!.openedAt).toBeGreaterThan(listed[2]!.openedAt);
  });

  it("gives the data-flow view the snapshot's last ten minutes of laps, aged by when the site stored them", async () => {
    const rig = await seedRig(3);
    const driver = await seedDriver("Matt G");
    const assignment = await openAssignment(rig.id, driver.id);
    for (const ago of [540, 480, 420, 360, 300, 240, 180, 120, 60, 0]) await heartbeat(rig, ago);
    // [completed, stored] seconds ago: a lap an outbox held for a while is
    // aged by when it arrived, not when it was driven.
    const laps: Array<[number, number, boolean, boolean]> = [
      [700, 690, true, true], // in the snapshot, but older than the traffic window
      [500, 60, true, true],
      [200, 190, false, true],
      [100, 95, false, false],
    ];
    for (const [completed, stored, valid, attributed] of laps) {
      await testDb().query(
        `insert into laps (event_id, rig_id, rig_assignment_id, driver_id, track_name, car_name,
           lap_time_ms, is_valid, invalid_reason, unattributed_cause, completed_at, created_at)
         values (gen_random_uuid()::text, $1, $2, $3, 'Spa', 'Porsche', 137217, $4, $5, $6,
           now() - make_interval(secs => $7), now() - make_interval(secs => $8))`,
        [
          rig.id,
          attributed ? assignment : null,
          attributed ? driver.id : null,
          valid,
          valid ? null : attributed ? "OFF_TRACK" : "UNATTRIBUTED",
          attributed ? null : "nobody_checked_in",
          completed,
          stored,
        ],
      );
    }

    const clock = await monitorClock(db());
    const snapshot = await loadSnapshot(db(), clock.now);
    const [lane] = flowModel(snapshot, evaluateRules(snapshot), clock.now).lanes;
    expect(lane!.broken).toBeNull();
    expect(lane!.nodes.agent.state).toBe("green");
    const lapTraffic = lane!.traffic.filter((t) => t.kind === "lap");
    expect(lapTraffic.map((t) => [t.status, Math.round(t.ageMs / 1000)])).toEqual([
      ["invalid", 190],
      ["unattributed", 95],
      ["accepted", 60],
    ]);
    expect(
      lane!.traffic.filter((t) => t.kind === "heartbeat").map((t) => Math.round(t.ageMs / 1000)),
    ).toEqual([540, 480, 420, 360, 300, 240, 180, 120, 60, 0]);
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

    it("alerts once, urgently, when the event board goes dark without a goodbye, though event mode ends", async () => {
      await setCombo();
      await board({ lastSeenAgoS: 4 * 60 });
      await expect(nextEvaluation()).resolves.toMatchObject({ eventMode: false });
      await nextEvaluation();
      await nextEvaluation();
      const dark = posts.filter((p) => p.content?.includes("has not been heard from"));
      expect(dark.map((p) => p.content)).toEqual([
        `<@${OWNER}> 🔴 Event board (Cadillac) has not been heard from for 4 min - laptop asleep, browser closed, or offline?`,
      ]);
      expect(await alerts()).toMatchObject([{ rule: "board_dark", subject: "board:event", resolved: false }]);
    });

    it("pages about a rig heard since event mode began, never about one quiet since before it", async () => {
      await setCombo();
      const rig = await seedRig(4);
      for (const ago of [900, 840, 780, 720, 660, 600, 540, 480, 420, 360, 300]) await heartbeat(rig, ago);
      await board();

      // Event mode comes on now, five minutes after the rig went quiet.
      await expect(nextEvaluation()).resolves.toMatchObject({ eventMode: true });
      await nextEvaluation();
      expect(await alerts()).toEqual([]);

      // Had it come on ten minutes ago, the same silence is mid-event.
      await testDb().query("update monitor_state set event_mode_changed_at = now() - interval '10 minutes'");
      await nextEvaluation();
      expect(await alerts()).toMatchObject([{ rule: "rig_silent", resolved: false }]);
      expect(contents().filter((c) => c?.includes("silent"))).toEqual([`<@${OWNER}> 🔴 Rig 04 has been silent for 5 min`]);
    });

    it("turns an open warning urgent once when event mode makes it urgent: stored, announced, diagnosed", async () => {
      await setCombo();
      const rig = await seedRig(4);
      for (const ago of [1200, 1140, 1080, 1020, 960, 900, 840, 780, 720, 660, 600, 540, 480]) {
        await heartbeat(rig, ago);
      }

      // An ordinary day: an empty rig quiet for 8 min is a quiet warning.
      await nextEvaluation();
      expect(contents()).toEqual(["🟡 Rig 04 has been silent for 8 min"]);
      expect(await alerts()).toMatchObject([{ rule: "rig_silent", notified: true }]);

      // Event mode began before the rig last spoke, so the rig was on for the
      // event: the same open alert is now urgent.
      await board();
      await nextEvaluation();
      await testDb().query("update monitor_state set event_mode_changed_at = now() - interval '30 minutes'");
      posts = [];
      await nextEvaluation();
      await nextEvaluation();

      expect(contents().filter((c) => c?.includes("silent"))).toEqual([
        `<@${OWNER}> 🔴 Rig 04 has been silent for 8 min`,
      ]);
      const { rows } = await testDb().query<{ severity: string; notified: boolean }>(
        "select severity, notified_at is not null as notified from monitor_alerts where rule = 'rig_silent'",
      );
      expect(rows).toEqual([{ severity: "urgent", notified: true }]);
      // Urgent, announced and still inside its retry window: due a diagnosis.
      await testDb().query("update monitor_alerts set diagnosis = null");
      await expect(claimDiagnoses()).resolves.toMatchObject([{ rule: "rig_silent", severity: "urgent" }]);
    });

    it("keeps event mode's start when the line saying it ended fails to post", async () => {
      await setCombo();
      const id = await board();
      await nextEvaluation();
      const { rows: began } = await testDb().query<{ at: string }>(
        `update monitor_state set event_mode_changed_at = now() - interval '2 hours'
         returning event_mode_changed_at::text as at`,
      );

      await testDb().query(
        "update board_heartbeats set last_seen_at = now() - interval '3 minutes', closed_at = now() - interval '3 minutes' where board_id = $1",
        [id],
      );
      discordAnswers = [500];
      await nextEvaluation();

      // Handed back whole: still on as far as the channel knows, and since
      // the moment it really began.
      const { rows } = await testDb().query<{ event_mode: boolean; same_start: boolean }>(
        "select event_mode, event_mode_changed_at = $1::timestamptz as same_start from monitor_state",
        [began[0]!.at],
      );
      expect(rows).toEqual([{ event_mode: true, same_start: true }]);

      await nextEvaluation();
      expect(contents().filter((c) => c?.startsWith("⚪ Event mode off"))).toHaveLength(1);
    });

    it("keeps event mode on across venue midnight for a board heard seconds before it", async () => {
      // The database cannot be moved to 00:00:10, so the venue's day is moved
      // instead: venue_today() says tomorrow, so the day began after the
      // board's last heartbeat, 20 s ago - a board heard at 23:59:50.
      const client = await testDb().connect();
      try {
        await client.query(
          `create or replace function venue_today() returns date language sql stable as $$
             select (now() at time zone 'America/Chicago')::date + 1
           $$`,
        );
        await setCombo();
        await board({ lastSeenAgoS: 20 });
        const { rows: began } = await testDb().query<{ at: string }>(
          `insert into monitor_state (id, event_mode, event_mode_changed_at)
           values (1, true, now() - interval '1 hour')
           on conflict (id) do update set event_mode = true, event_mode_changed_at = excluded.event_mode_changed_at
           returning event_mode_changed_at::text as at`,
        );

        await expect(nextEvaluation()).resolves.toMatchObject({ eventMode: true });
        expect(contents().filter((c) => c?.startsWith("⚪"))).toEqual([]);
        const { rows } = await testDb().query<{ same_start: boolean }>(
          "select event_mode_changed_at = $1::timestamptz as same_start from monitor_state",
          [began[0]!.at],
        );
        expect(rows).toEqual([{ same_start: true }]);
      } finally {
        await client.query(
          `create or replace function venue_today() returns date language sql stable as $$
             select (now() at time zone 'America/Chicago')::date
           $$`,
        );
        client.release();
      }
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
