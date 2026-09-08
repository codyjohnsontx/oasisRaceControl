/**
 * Twenty-rig soak — puts a number behind "a platform for a 20-25 station venue".
 *
 * Runs N concurrent scripts/fake-rig.ts processes against a local stack for a
 * fixed duration, then asserts on what the venue actually cares about: that
 * every lap the rigs sent is stored exactly once, credited to the driver who
 * was in that seat, and that the write path stayed inside the timings the real
 * .NET agent is built around. Results and method: docs/soak-20-rigs.md.
 *
 * Usage (see docs/soak-20-rigs.md for the full runbook):
 *   SOAK_DATABASE_URL=postgres://postgres:postgres@localhost:5455/oasis_soak_test \
 *   npx tsx scripts/soak.ts --rigs 20 --minutes 60 --out ../../docs/soak-20-rigs.json
 *
 *     --rigs <n>          concurrent rig processes           default: 20
 *     --minutes <n>       how long to hold the load          default: 60
 *     --interval <s>      seconds between laps per rig       default: 20
 *     --base <url>        the stack under test               default: http://localhost:3000
 *     --work <dir>        where worker logs/metrics land     default: a temp dir
 *     --out <path>        write the summary JSON here        default: print only
 *
 * The database is provisioned by this script and must be disposable: it is read
 * through the same guard the integration suite uses (src/test/db-guard.ts), so a
 * managed host, a non-local host, or a name without "test" in it is refused
 * before a connection is opened. Migrate and seed it first — the soak adds rigs
 * and drivers but does not build a schema, and the seeded featured combo is what
 * decides which of the generated laps rank.
 *
 * It does NOT put the customer-facing read path under load: twenty writers, no
 * wall polling alongside them. The numbers are the ingestion path's, and the
 * doc says so rather than implying more.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { cpus, totalmem, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { safeTestDatabaseUrl } from "../src/test/db-guard";

/**
 * Both ceilings are the real agent's own numbers, not a target invented to be
 * met. Past the flush interval (AgentService.FlushInterval) a rig's outbox
 * drains slower than it fills, so the backlog grows for as long as the load
 * lasts; past the HTTP timeout (OasisRigAgent/Program.cs) the agent abandons
 * the request outright and re-sends the batch. They are deliberately loose —
 * they say "the venue still works", not "this is fast". What a change actually
 * gets compared against is the measured figure recorded in the committed
 * summary, which is why that file names the machine it was produced on.
 */
const AGENT_FLUSH_INTERVAL_MS = 5_000;
const AGENT_HTTP_TIMEOUT_MS = 15_000;

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const RIGS = Number(arg("rigs", "20"));
const MINUTES = Number(arg("minutes", "60"));
const INTERVAL_S = Number(arg("interval", "20"));
const BASE = arg("base", "http://localhost:3000").replace(/\/$/, "");
const OUT = arg("out", "") && resolve(arg("out", ""));
/** Kept clear of the seed's rigs 1-3 so a soak can run on a seeded database. */
const RIG_NUMBER_BASE = 101;

const RUN_ID = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
/** Absolute, because this process and its workers do not share a cwd: the
 *  workers run from apps/web, so a relative --work would name two different
 *  directories and every worker's metrics would land where nothing reads. */
const WORK_DIR = resolve(arg("work", join(tmpdir(), `oasis-soak-${RUN_ID}`)));

type Rig = {
  rigNumber: number;
  rigId: string;
  driverId: string;
  driverName: string;
  assignmentId: string;
  token: string;
};

/** One request as the rig experienced it (scripts/fake-rig.ts --metrics). */
type Metric = {
  t: string;
  kind: "lap" | "heartbeat" | "poll";
  ms: number;
  status?: number;
  error?: string;
  sent?: string[];
  results?: Array<{ eventId?: string; status: string }>;
};

async function main(): Promise<void> {
  // A NaN here does not stop the run, it degrades it silently: `--minutes 30m`
  // collapses the hold to nothing and every check then passes over twenty
  // seconds of traffic, and `--interval 20s` reaches every worker's
  // setInterval as a 1 ms lap. Both would write a summary that looks ordinary.
  for (const [name, value] of [
    ["rigs", RIGS],
    ["minutes", MINUTES],
    ["interval", INTERVAL_S],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`--${name} must be a positive number, got "${arg(name, "")}".`);
    }
  }

  const configured = process.env.SOAK_DATABASE_URL;
  const url = configured ? safeTestDatabaseUrl(configured) : null;
  if (!url) {
    throw new Error(
      "SOAK_DATABASE_URL is not set. It must be a local, disposable database " +
        "with 'test' in its name — this script writes rigs, drivers and " +
        "assignments into it. See docs/soak-20-rigs.md.",
    );
  }

  // The summary is only written once the load has been held, so a --out that
  // cannot be written costs the whole run the one artifact it exists to
  // produce. Opening the target itself is what settles it: the directory being
  // writable says nothing about `--out ../../docs` naming that directory, or
  // about an existing file being read-only.
  if (OUT) {
    try {
      closeSync(openSync(OUT, "a"));
    } catch {
      throw new Error(
        `--out ${arg("out", "")} resolves to ${OUT}, which cannot be opened for ` +
          `writing - it is a directory, an unwritable file, or under a folder ` +
          `that does not exist.`,
      );
    }
  }

  mkdirSync(WORK_DIR, { recursive: true });
  console.log(`[soak] run ${RUN_ID}: ${RIGS} rigs x ${MINUTES} min against ${BASE}`);
  console.log(`[soak] worker logs and metrics: ${WORK_DIR}`);

  const client = new Client({ connectionString: url });
  await client.connect();

  // Owned out here so the cleanup below can see workers that were started
  // before whatever went wrong: a failure partway through the ramp would
  // otherwise leave the ones already up driving the stack after this exits.
  const workers: ChildProcess[] = [];
  let summary: Awaited<ReturnType<typeof summarise>>;
  try {
    const rigs = await provision(client, RIGS);
    console.log(`[soak] provisioned rigs ${rigs[0]!.rigNumber}-${rigs.at(-1)!.rigNumber}`);
    await preflight(rigs);

    // The clock covers the staggered ramp-up as well as the steady state, so
    // every request a worker made falls inside the window the rates are
    // computed over. At an hour the ramp is one interval and moves nothing.
    const startedAt = new Date();
    await startWorkers(rigs, workers);
    console.log(`[soak] ${workers.length} workers up — holding load for ${MINUTES} min`);
    await sleep(MINUTES * 60_000);
    const endedAt = new Date();

    console.log(`[soak] ${MINUTES} min elapsed — stopping ${workers.length} workers`);
    const diedEarly = await stopAll(workers);

    const metricsByRig = rigs.map((rig) => readMetrics(rig));
    const failure = loadFailure(rigs, workers, diedEarly, metricsByRig);
    if (failure) throw new Error(failure);

    summary = await summarise(
      client,
      rigs,
      metricsByRig.flatMap((m) => m.metrics),
      startedAt,
      endedAt,
      url,
    );
  } finally {
    // Nothing past this point is measured, so a worker still alive here is one
    // this script failed to stop. Twenty orphaned processes left hammering the
    // stack is a worse outcome than any error being propagated, and closing
    // the client must not mask that error either.
    for (const child of workers) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await client.end().catch(() => {});
  }

  report(summary);
  if (OUT) {
    writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`[soak] summary written to ${OUT}`);
  }
  // Not process.exit: report() writes through console.log, and on a pipe or a
  // file stdout is asynchronous, so exiting here can truncate the summary the
  // run exists to produce. Setting the code lets Node drain and exit on its own.
  process.exitCode = summary.checks.every((c) => c.pass) ? 0 : 1;
}

/**
 * Creates the rigs, drivers and open assignments the run needs, and hands back
 * the bearer tokens. Re-running reuses the same rig numbers and drivers with a
 * fresh token, so a soak database can be soaked again without accumulating a
 * new set of twenty rigs each time.
 *
 * Everything each rig writes is therefore owned by one driver for the whole
 * run: attribution is asserted exactly rather than approximately, at the cost
 * of not exercising a seat changing hands mid-load. The check-in/checkout races
 * that a driver change would exercise already have their own integration tests.
 */
async function provision(client: Client, count: number): Promise<Rig[]> {
  const rigs: Rig[] = [];
  for (let i = 0; i < count; i++) {
    const rigNumber = RIG_NUMBER_BASE + i;
    const token = `soak-${RUN_ID}-rig-${rigNumber}-${randomUUID().slice(0, 8)}`;
    const hash = createHash("sha256").update(token).digest("hex");
    const driverName = `Soak Driver ${rigNumber}`;

    const { rows: rigRows } = await client.query<{ id: string }>(
      `insert into rigs (rig_number, display_name, agent_token_hash)
       values ($1, $2, $3)
       on conflict (rig_number)
         do update set agent_token_hash = excluded.agent_token_hash
       returning id`,
      [rigNumber, `Soak Rig ${rigNumber}`, hash],
    );
    const rigId = rigRows[0]!.id;

    const { rows: driverRows } = await client.query<{ id: string }>(
      `insert into drivers (display_name, is_guest) values ($1, true)
       on conflict (display_name) do update set updated_at = now()
       returning id`,
      [driverName],
    );
    const driverId = driverRows[0]!.id;

    // one_open_assignment_per_rig / _per_driver are partial unique indexes, so
    // a re-run has to close last run's stint before opening this one.
    await client.query(
      `update rig_assignments set ended_at = now(), end_reason = 'staff_cleared'
       where ended_at is null and (rig_id = $1 or driver_id = $2)`,
      [rigId, driverId],
    );
    const { rows: assignmentRows } = await client.query<{ id: string }>(
      `insert into rig_assignments (rig_id, driver_id) values ($1, $2) returning id`,
      [rigId, driverId],
    );

    rigs.push({
      rigNumber,
      rigId,
      driverId,
      driverName,
      assignmentId: assignmentRows[0]!.id,
      token,
    });
  }
  return rigs;
}

/**
 * Proves the stack is up and every token resolves to its own open assignment
 * before an hour is spent on it. A soak that discovers in post-processing that
 * the server was never listening has cost an hour to learn nothing.
 */
async function preflight(rigs: Rig[]): Promise<void> {
  for (const rig of rigs) {
    const res = await fetch(`${BASE}/api/agent/assignment`, {
      headers: { authorization: `Bearer ${rig.token}` },
    }).catch((error: Error) => {
      throw new Error(`${BASE} is not answering: ${error.message}`);
    });
    if (!res.ok) throw new Error(`rig ${rig.rigNumber}: assignment poll HTTP ${res.status}`);
    const body = (await res.json()) as { assignment: { id: string } | null };
    if (body.assignment?.id !== rig.assignmentId) {
      throw new Error(
        `rig ${rig.rigNumber}: backend reports assignment ${body.assignment?.id ?? "none"}, ` +
          `expected ${rig.assignmentId} — is it pointed at the soak database?`,
      );
    }
  }
  console.log(`[soak] preflight ok: ${rigs.length} rigs authenticated and checked in`);
}

/** Scoped by run, not just by rig: fake-rig APPENDS, so two runs sharing a
 *  --work directory would otherwise read as one - twice the requests over one
 *  run's duration, every percentile computed across both, and all seven checks
 *  still passing. Keeping a directory's runs side by side is the point of the
 *  flag; blending them into one summary is what must not happen. */
const metricsPath = (rig: Rig): string =>
  join(WORK_DIR, `${RUN_ID}-rig-${rig.rigNumber}.jsonl`);

/**
 * Spawns the workers spread evenly across one lap interval rather than all in
 * the same millisecond. Twenty rigs firing together every twenty seconds is a
 * synthetic drumbeat, not a venue: real stations start whenever somebody sits
 * down, and a backend that only ever sees a thundering herd is measured against
 * a load it will not meet. The spread costs one interval of the run.
 */
async function startWorkers(rigs: Rig[], started: ChildProcess[]): Promise<void> {
  const gapMs = (INTERVAL_S * 1000) / rigs.length;
  for (const rig of rigs) {
    started.push(startWorker(rig));
    await sleep(gapMs);
    throwIfLaunchFailed();
  }
  throwIfLaunchFailed();
}

/**
 * `spawn` reports a failure to launch through the child's `error` event rather
 * than by throwing, and an `error` event with no listener is re-raised as an
 * uncaught exception. Collecting them here turns that into an ordinary failure
 * the caller's cleanup can act on, and checking between spawns means a bad
 * launch stops the ramp instead of being discovered after the full hold.
 */
const launchErrors: string[] = [];

function throwIfLaunchFailed(): void {
  if (launchErrors.length > 0) {
    throw new Error(`worker launch failed - ${launchErrors.join("; ")}`);
  }
}

/**
 * `node --import tsx`, not the `tsx` CLI: the CLI is a launcher that spawns the
 * real worker as a child, so twenty rigs would be forty processes and SIGINT
 * would have to survive being forwarded. Registering the loader in-process
 * makes each rig exactly one process that this script signals directly.
 * (~88 MB resident each either way — the saving is in moving parts, not RAM.)
 */
function startWorker(rig: Rig): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      "--import", "tsx",
      join(__dirname, "fake-rig.ts"),
      "--token", rig.token,
      "--base", BASE,
      "--interval", String(INTERVAL_S),
      "--metrics", metricsPath(rig),
    ],
    {
      cwd: join(__dirname, ".."),
      // A worker's own chatter is one line per request; twenty of them for an
      // hour is noise nobody reads, and the metrics file holds what matters.
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  child.once("error", (error: Error) => {
    launchErrors.push(`rig ${rig.rigNumber}: ${error.message}`);
  });
  return child;
}

/**
 * Signals every worker and reports the indexes of the ones that were already
 * gone - the only moment a worker lost mid-run is distinguishable from one this
 * script stopped, since after the kills every child has an exit code.
 */
async function stopAll(workers: ChildProcess[]): Promise<number[]> {
  const diedEarly: number[] = [];
  const exits = workers.map(
    (child, i) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          diedEarly.push(i);
          return resolve();
        }
        child.once("exit", () => resolve());
        child.kill("SIGINT");
        // A worker mid-request can outlive SIGINT, so escalate - but resolve
        // ONLY from the exit event. Resolving alongside the SIGKILL would let
        // readMetrics run while a worker was still appending: that request
        // would drop out of the reconciliation, and a lap already stored would
        // then surface as an unexplained stray. SIGKILL cannot be caught, so
        // waiting for the exit costs nothing and removes the race.
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      }),
  );
  await Promise.all(exits);
  return diedEarly;
}

/**
 * Why this run cannot be summarised, or null when it can. Every check is
 * computed from what the rigs recorded sending, so a run whose workers were
 * killed at minute two still has every lap they sent stored, still absorbs
 * every duplicate, and still passes all seven - over ninety seconds of traffic
 * a summary would file under the full duration and twenty rigs. A run that
 * lost a worker, or never heard from one, is refused rather than written up.
 */
function loadFailure(
  rigs: Rig[],
  workers: ChildProcess[],
  diedEarly: number[],
  metricsByRig: ReturnType<typeof readMetrics>[],
): string | null {
  const lost = diedEarly.map((i) => {
    const child = workers[i]!;
    return `rig ${rigs[i]!.rigNumber} (${child.signalCode ?? `exit ${child.exitCode}`})`;
  });
  if (lost.length > 0) {
    return (
      `${lost.length} of ${workers.length} workers died before the run ended: ` +
      `${lost.join(", ")}. Their traffic stopped when they did, so this run is ` +
      `not ${RIGS} rigs for ${MINUTES} minutes and its numbers are not comparable.`
    );
  }

  const silent = rigs.filter((_, i) => metricsByRig[i]!.metrics.length === 0);
  if (silent.length > 0) {
    return (
      `${silent.length} workers recorded no requests at all (rigs ` +
      `${silent.map((r) => r.rigNumber).join(", ")}). There is nothing to ` +
      `reconcile for them, and checks computed over nothing pass vacuously.`
    );
  }

  const unreadable = rigs.filter((_, i) => metricsByRig[i]!.unreadableLines > 0);
  if (unreadable.length > 0) {
    const lines = metricsByRig.reduce((n, m) => n + m.unreadableLines, 0);
    return (
      `${lines} metric line(s) could not be read (rigs ` +
      `${unreadable.map((r) => r.rigNumber).join(", ")}). Each one is a request ` +
      `missing from the reconciliation, and a lap already stored would be ` +
      `reported as a stray no rig sent.`
    );
  }
  return null;
}

/**
 * A line the reader cannot read is a request that vanishes from the
 * reconciliation, and a lap already in the database would then be reported as
 * a stray no rig sent. They are counted rather than dropped so `loadFailure`
 * can refuse the run: a reader that silently discards what it cannot parse is
 * a check that cannot fail.
 */
function readMetrics(rig: Rig): { metrics: Metric[]; unreadableLines: number } {
  const path = metricsPath(rig);
  if (!existsSync(path)) return { metrics: [], unreadableLines: 0 };
  const metrics: Metric[] = [];
  let unreadableLines = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      metrics.push(JSON.parse(line) as Metric);
    } catch {
      unreadableLines += 1;
    }
  }
  return { metrics, unreadableLines };
}

type Check = { name: string; pass: boolean; detail: string };

/** Nearest-rank percentile: the smallest sample at or above the given share. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

function latency(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    meanMs: sorted.length
      ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length)
      : 0,
    p50Ms: percentile(sorted, 0.5),
    p90Ms: percentile(sorted, 0.9),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1) ?? 0,
  };
}

async function summarise(
  client: Client,
  rigs: Rig[],
  metrics: Metric[],
  startedAt: Date,
  endedAt: Date,
  url: string,
) {
  const byKind = (kind: Metric["kind"]) => metrics.filter((m) => m.kind === kind);
  const lapPosts = byKind("lap");

  // What the rigs believe they sent. Duplicates are deliberate: fake-rig
  // re-sends roughly one lap in fourteen to exercise the idempotency key, so
  // sends and distinct ids are different numbers and both matter.
  const sentIds = lapPosts.flatMap((m) => m.sent ?? []);
  const distinctIds = [...new Set(sentIds)];
  const verdicts = lapPosts.flatMap((m) => m.results ?? []);
  const tally = (status: string) => verdicts.filter((v) => v.status === status).length;
  const resends = sentIds.length - distinctIds.length;

  // A lap post the backend never confirmed holding: fake-rig records what it
  // sent even when the request fails, so the id is in `sentIds` with no verdict
  // behind it — and a 200 can still carry `error`, which is a verdict that the
  // row was NOT stored, leaving nothing for a later resend to duplicate. Both
  // are what make the duplicate arithmetic below unanswerable.
  const lapPostsNotStored = lapPosts.filter(
    (m) =>
      (m.results ?? []).filter((r) => r.status !== "error").length !==
      (m.sent ?? []).length,
  ).length;
  const lapVerdictsComplete = lapPostsNotStored === 0;

  const transportErrors = metrics.filter((m) => m.error !== undefined);
  const nonOk = metrics.filter((m) => m.error === undefined && m.status !== 200);

  // What the database actually holds, matched to the ids the rigs recorded —
  // not to a time window, so a re-run against the same database cannot inflate
  // or deflate the count.
  const { rows: stored } = await client.query<{
    event_id: string;
    rig_id: string;
    driver_id: string | null;
    is_valid: boolean;
    unattributed_cause: string | null;
  }>(
    `select event_id, rig_id, driver_id, is_valid, unattributed_cause
     from laps where event_id = any($1::text[])`,
    [distinctIds],
  );

  // Distinct failures, deliberately not merged: a lap credited to the wrong
  // driver and a lap the backend refused to credit at all are opposite
  // behaviours, and one driver per rig for the whole run means neither is
  // acceptable here.
  const ownerByRigId = new Map(rigs.map((r) => [r.rigId, r.driverId]));
  const unattributed = stored.filter((lap) => lap.driver_id === null);
  const misattributed = stored.filter(
    (lap) => lap.driver_id !== null && lap.driver_id !== ownerByRigId.get(lap.rig_id),
  );

  // Anything this run's rigs wrote that the rigs themselves never recorded
  // sending — cross-talk between rigs, or a stale worker from another run.
  const { rows: strayRows } = await client.query<{ count: string }>(
    `select count(*) from laps
     where rig_id = any($1::uuid[]) and created_at >= $2
       and not (event_id = any($3::text[]))`,
    [rigs.map((r) => r.rigId), startedAt.toISOString(), distinctIds],
  );
  const strays = Number(strayRows[0]!.count);

  const events = latency([...lapPosts, ...byKind("heartbeat")].map((m) => m.ms));
  const polls = latency(byKind("poll").map((m) => m.ms));
  const durationS = (endedAt.getTime() - startedAt.getTime()) / 1000;

  const { rows: pgRows } = await client.query<{ version: string }>("select version()");

  const checks: Check[] = [
    {
      name: "every lap sent is stored",
      pass: stored.length === distinctIds.length,
      detail: `${stored.length} stored / ${distinctIds.length} distinct sent`,
    },
    {
      name: "every lap is credited to the driver in that seat",
      pass: misattributed.length === 0 && unattributed.length === 0,
      detail: `${misattributed.length} misattributed, ${unattributed.length} unattributed`,
    },
    {
      name: "no lap appears that no rig sent",
      pass: strays === 0,
      detail: `${strays} unaccounted-for laps on soak rigs`,
    },
    {
      // Only computable when every lap post came back stored. A post that
      // failed, or that the backend answered `error`, still contributes its
      // event id to `sentIds`, so a failed original followed by a successful
      // resend would count as a resend the backend never saw and had no
      // duplicate to absorb. That is a gap in the evidence, not a defect in
      // the backend, and reporting it either way would be wrong - so it is
      // declared indeterminate and the run does not pass on it. The request
      // check below is what names the underlying cause.
      name: "duplicate event ids were absorbed, not double-stored",
      pass: lapVerdictsComplete && tally("duplicate") === resends,
      detail: lapVerdictsComplete
        ? `${tally("duplicate")} duplicate verdicts / ${resends} resends`
        : `indeterminate - ${lapPostsNotStored} lap post(s) were never confirmed ` +
          `stored, so the ${resends} recorded resends cannot be matched against ` +
          `${tally("duplicate")} duplicate verdicts`,
    },
    {
      name: "every request answered 200",
      pass: transportErrors.length === 0 && nonOk.length === 0,
      detail: `${transportErrors.length} transport errors, ${nonOk.length} non-200`,
    },
    {
      name: `events p95 under the agent's ${AGENT_FLUSH_INTERVAL_MS / 1000}s flush interval`,
      pass: events.p95Ms < AGENT_FLUSH_INTERVAL_MS,
      detail: `p95 ${events.p95Ms} ms`,
    },
    {
      name: `events max under the agent's ${AGENT_HTTP_TIMEOUT_MS / 1000}s HTTP timeout`,
      pass: events.maxMs < AGENT_HTTP_TIMEOUT_MS,
      detail: `max ${events.maxMs} ms`,
    },
  ];

  return {
    runId: RUN_ID,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMinutes: Math.round(durationS / 6) / 10,
    load: {
      rigs: rigs.length,
      lapIntervalSeconds: INTERVAL_S,
      base: BASE,
      note:
        "Ingestion path only — no customer-display read load ran alongside these writers.",
    },
    machine: {
      cpu: cpus()[0]?.model ?? "unknown",
      cores: cpus().length,
      memoryGb: Math.round(totalmem() / 1024 ** 3),
      node: process.version,
      postgres: pgRows[0]!.version.split(" ").slice(0, 2).join(" "),
      database: new URL(url).pathname.slice(1),
    },
    requests: {
      total: metrics.length,
      perSecond: Math.round((metrics.length / durationS) * 100) / 100,
      lapPosts: lapPosts.length,
      heartbeats: byKind("heartbeat").length,
      assignmentPolls: byKind("poll").length,
      transportErrors: transportErrors.length,
      nonOk: nonOk.length,
    },
    laps: {
      sent: sentIds.length,
      distinct: distinctIds.length,
      deliberateResends: resends,
      stored: stored.length,
      valid: stored.filter((l) => l.is_valid).length,
      invalid: stored.filter((l) => !l.is_valid).length,
      misattributed: misattributed.length,
      unattributed: unattributed.length,
      strays,
      verdicts: {
        accepted: tally("accepted"),
        acceptedInvalid: tally("accepted_invalid"),
        acceptedUnattributed: tally("accepted_unattributed"),
        duplicate: tally("duplicate"),
        error: tally("error"),
      },
    },
    latency: { events, assignmentPolls: polls },
    thresholds: {
      eventsP95Ms: AGENT_FLUSH_INTERVAL_MS,
      eventsMaxMs: AGENT_HTTP_TIMEOUT_MS,
      source: "apps/rig-agent: AgentService.FlushInterval, Program.cs HttpClient.Timeout",
    },
    checks,
  };
}

function report(s: Awaited<ReturnType<typeof summarise>>): void {
  console.log(`\n=== soak ${s.runId} — ${s.load.rigs} rigs, ${s.durationMinutes} min ===`);
  console.log(
    `requests ${s.requests.total} (${s.requests.perSecond}/s): ` +
      `${s.requests.lapPosts} lap posts, ${s.requests.heartbeats} heartbeats, ` +
      `${s.requests.assignmentPolls} polls`,
  );
  console.log(
    `laps     ${s.laps.sent} sent (${s.laps.distinct} distinct, ` +
      `${s.laps.deliberateResends} resent) -> ${s.laps.stored} stored ` +
      `(${s.laps.valid} valid, ${s.laps.invalid} invalid)`,
  );
  console.log(
    `events   p50 ${s.latency.events.p50Ms}ms  p95 ${s.latency.events.p95Ms}ms  ` +
      `p99 ${s.latency.events.p99Ms}ms  max ${s.latency.events.maxMs}ms`,
  );
  console.log(
    `polls    p50 ${s.latency.assignmentPolls.p50Ms}ms  ` +
      `p95 ${s.latency.assignmentPolls.p95Ms}ms  max ${s.latency.assignmentPolls.maxMs}ms`,
  );
  console.log("");
  for (const check of s.checks) {
    console.log(`${check.pass ? "PASS" : "FAIL"}  ${check.name} — ${check.detail}`);
  }
  console.log("");
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Not process.exit, for the same reason the success path is not: stderr is
// asynchronous to a pipe or a file, and this message is the only explanation a
// refused run produces.
main().catch((error: Error) => {
  console.error(`[soak] ${error.message}`);
  process.exitCode = 1;
});
