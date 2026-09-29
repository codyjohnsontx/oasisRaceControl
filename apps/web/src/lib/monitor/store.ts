import type { QueryResult, QueryResultRow } from "pg";
import { query, queryOne } from "@/lib/db";
import type { HeartbeatRow as DiagnosisHeartbeat } from "./diagnosis/context";
import type { AlertForMessage } from "./messages";
import type { Heartbeat } from "./rig-state";
import {
  HEARD_HISTORY_MS,
  SILENT_AFTER_MS,
  type AlertDetail,
  type Finding,
  type MonitorSnapshot,
  type RigSnapshot,
  type Severity,
} from "./rules";

/**
 * The monitor's database side: the evaluation throttle, the snapshot the rules
 * read, and the alert transitions (db/migrations/0006_monitor.sql).
 *
 * An evaluation's claim, snapshot and transitions run in ONE transaction on
 * one client (runMonitor), and the claim is an upsert of the single
 * monitor_state row, so it holds that row's lock until the transaction
 * commits. A second evaluation's claim waits on the lock and then finds the
 * first one's timestamp, so evaluations are serialized, not merely spaced: a
 * slow evaluation's old snapshot can never be applied after a newer one's
 * (two stale "absent" counts resolving an alert that is present, or a stale
 * level moving it backwards). The transaction does no network I/O and
 * commits before any Discord post, so it holds the lock for a handful of
 * short statements. Each transition is also one statement whose WHERE clause
 * is its guard, and whoever wins a transition is the only one that posts it.
 */

/** A pool or a transaction's client: anything these statements can run on. */
export type Db = {
  query<Row extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
};

async function rows<Row extends QueryResultRow>(
  db: Db,
  text: string,
  values: unknown[] = [],
): Promise<Row[]> {
  return (await db.query<Row>(text, values)).rows;
}

/**
 * At most one evaluation this often, however many heartbeats and ticks arrive.
 * It bounds the database work the monitor adds at twenty rigs to one snapshot
 * every few seconds, and it is also how far apart the two evaluations that
 * resolve an alert are at least (RESOLVE_AFTER_ABSENT).
 */
const EVALUATION_INTERVAL = "20 seconds";

/** A problem must be gone from this many evaluations in a row to recover. */
const RESOLVE_AFTER_ABSENT = 2;

/** History the rules read: rules 2, 3a, 10 and 18 look back this far at most. */
const HISTORY = "15 minutes";
/**
 * And this far before a rig's latest heartbeat, however old that is, so the
 * goodbye an ordinary heartbeat overtook is still in view when the rig has
 * been quiet ever since (rigState in rig-state.ts).
 */
const BEFORE_LATEST = "5 minutes";

/**
 * A post that failed is retried by later evaluations until this long after the
 * alert opened (or its level last rose) - monitor_alerts.notify_until, fixed
 * then and never moved by the problem persisting or by a retry. A post that
 * timed out may still have reached Discord, and nothing Discord offers lets
 * the monitor ask, so such a retry can show the same alert twice; the
 * deadline is what bounds that to one hour of once-a-minute retries rather
 * than the life of the problem.
 */
const RETRY_FOR = "1 hour";
/** And no sooner than this after the previous attempt at the same post. */
const RETRY_AFTER = "60 seconds";

const HEARTBEAT_RETENTION = "7 days";
const PRUNE_EVERY = "24 hours";

/**
 * Claims this evaluation, or returns null when another one ran within
 * EVALUATION_INTERVAL. Answers with the database's now(), which every rule
 * judges by, so no instance's own clock enters a comparison. An upsert rather
 * than an update so a missing state row (a test database truncated around it)
 * is recreated instead of silently stopping the monitor.
 */
export async function claimEvaluation(db: Db): Promise<{ now: number } | null> {
  const [row] = await rows<{ now_ms: number }>(
    db,
    `insert into monitor_state as s (id, last_evaluated_at) values (1, now())
     on conflict (id) do update set last_evaluated_at = excluded.last_evaluated_at
     where s.last_evaluated_at is null or s.last_evaluated_at < now() - $1::interval
     returning (extract(epoch from now()) * 1000)::float8 as now_ms`,
    [EVALUATION_INTERVAL],
  );
  return row ? { now: row.now_ms } : null;
}

export type OpenAlert = { id: string; rule: string; subject: string };

export async function loadSnapshot(
  db: Db,
  now: number,
): Promise<MonitorSnapshot & { openAlerts: OpenAlert[] }> {
  // One client runs one statement at a time; these queue on it in order.
  const [rigRows, heartbeatRows, heardRows, openAlerts] = await Promise.all([
    rows<{
      id: string;
      rig_number: number;
      display_name: string;
      last_seen_at: Date | null;
      seated_since: Date | null;
      driver_name: string | null;
      driver_status: string | null;
    }>(
      db,
      `select r.id, r.rig_number, r.display_name, r.last_seen_at,
              ra.started_at as seated_since, d.display_name::text as driver_name,
              d.status::text as driver_status
       from rigs r
       left join rig_assignments ra on ra.rig_id = r.id and ra.ended_at is null
       left join drivers d on d.id = ra.driver_id
       order by r.rig_number`,
    ),
    // Through each rig's latest heartbeat (one index lookup per rig) and then
    // an index range from there, so the read is bounded by HISTORY however
    // much history is retained.
    rows<HeartbeatRow>(
      db,
      `select h.id::text, h.rig_id, h.received_at, h.sent_at,
              h.clock_skew_ms::float8 as clock_skew_ms, h.process_started_at,
              h.agent_version, h.sim_connected, h.telemetry_faulted,
              h.pending_laps, h.rejected_laps, h.checkout, h.shutting_down,
              h.payload->>'telemetryMode' as telemetry_mode,
              (h.payload->>'sequence')::float8 as sequence,
              (h.payload->>'oldestPendingAgeS')::float8 as oldest_pending_age_s,
              h.payload->'missingVariables' as missing_variables,
              (h.payload->>'agentCpuPercent')::float8 as agent_cpu_percent,
              (h.payload->>'agentMemoryMb')::float8 as agent_memory_mb
       from v_rig_latest_heartbeat latest
       join rig_heartbeats h
         on h.rig_id = latest.rig_id
        and h.received_at >= least(now() - $1::interval, latest.received_at - $2::interval)
       order by h.rig_id, h.received_at, h.id`,
      [HISTORY, BEFORE_LATEST],
    ),
    // Each rig's unbroken runs of heartbeats over HEARD_HISTORY_MS: an index
    // range per rig, folded in the database so only the runs come back.
    rows<{ rig_id: string; heard_from: Date; heard_to: Date }>(
      db,
      `select rig_id, min(received_at) as heard_from, max(received_at) as heard_to
       from (
         select rig_id, received_at,
                sum(case when received_at - previous > $2::interval then 1 else 0 end)
                  over (partition by rig_id order by received_at) as run
         from (
           select h.rig_id, h.received_at,
                  lag(h.received_at) over (partition by h.rig_id order by h.received_at) as previous
           from rigs r
           join rig_heartbeats h on h.rig_id = r.id and h.received_at >= now() - $1::interval
         ) gaps
       ) runs
       group by rig_id, run
       order by rig_id, heard_from`,
      [`${HEARD_HISTORY_MS / 1000} seconds`, `${SILENT_AFTER_MS / 1000} seconds`],
    ),
    rows<OpenAlert>(
      db,
      "select id::text, rule, subject from monitor_alerts where resolved_at is null",
    ),
  ]);

  const byRig = new Map<string, Heartbeat[]>();
  for (const row of heartbeatRows) {
    const list = byRig.get(row.rig_id) ?? [];
    list.push(toHeartbeat(row));
    byRig.set(row.rig_id, list);
  }

  const heardByRig = new Map<string, RigSnapshot["heard"]>();
  for (const row of heardRows) {
    const list = heardByRig.get(row.rig_id) ?? [];
    list.push({ from: row.heard_from.getTime(), to: row.heard_to.getTime() });
    heardByRig.set(row.rig_id, list);
  }

  const rigs: RigSnapshot[] = rigRows.map((row) => ({
    id: row.id,
    number: row.rig_number,
    name: row.display_name,
    lastSeenAt: row.last_seen_at?.getTime() ?? null,
    seated:
      row.seated_since && row.driver_name && row.driver_status
        ? {
            driverName: row.driver_name,
            driverStatus: row.driver_status,
            startedAt: row.seated_since.getTime(),
          }
        : null,
    heartbeats: byRig.get(row.id) ?? [],
    heard: heardByRig.get(row.id) ?? [],
  }));

  return { now, rigs, openAlerts };
}

type HeartbeatRow = {
  id: string;
  rig_id: string;
  received_at: Date;
  sent_at: Date | null;
  clock_skew_ms: number | null;
  process_started_at: Date | null;
  agent_version: string | null;
  sim_connected: boolean | null;
  telemetry_faulted: boolean | null;
  pending_laps: number | null;
  rejected_laps: number | null;
  checkout: string | null;
  shutting_down: boolean;
  telemetry_mode: string | null;
  sequence: number | null;
  oldest_pending_age_s: number | null;
  missing_variables: unknown;
  agent_cpu_percent: number | null;
  agent_memory_mb: number | null;
};

function toHeartbeat(row: HeartbeatRow): Heartbeat {
  return {
    id: row.id,
    receivedAt: row.received_at.getTime(),
    sentAt: row.sent_at?.getTime() ?? null,
    clockSkewMs: row.clock_skew_ms,
    processStartedAt: row.process_started_at?.getTime() ?? null,
    sequence: row.sequence,
    agentVersion: row.agent_version,
    telemetryMode: row.telemetry_mode,
    simConnected: row.sim_connected,
    telemetryFaulted: row.telemetry_faulted,
    pendingLaps: row.pending_laps,
    oldestPendingAgeS: row.oldest_pending_age_s,
    rejectedLaps: row.rejected_laps,
    checkout: row.checkout,
    missingVariables: Array.isArray(row.missing_variables)
      ? row.missing_variables.filter((name): name is string => typeof name === "string")
      : [],
    agentCpuPercent: row.agent_cpu_percent,
    agentMemoryMb: row.agent_memory_mb,
    shuttingDown: row.shutting_down,
  };
}

/**
 * Turns this evaluation's findings into alert transitions. Returns the alerts
 * this evaluation won the right to post: `announce` (opened, or got worse) and
 * `recover` (resolved, having been announced).
 *
 * - Open: INSERT ... ON CONFLICT against monitor_alerts_one_open. Only the
 *   evaluation whose row was inserted announces; a problem already open only
 *   has its last_seen_at, detail and absence count refreshed.
 * - Worse: a finding whose level rose re-announces once per rise, claimed by
 *   the update that moved the level.
 * - Recover: an open alert no finding named counts one absence; the evaluation
 *   whose update reaches RESOLVE_AFTER_ABSENT resolves it and posts.
 */
export async function applyFindings(
  db: Db,
  findings: readonly Finding[],
  openAlerts: readonly OpenAlert[],
): Promise<{ announce: string[]; recover: string[] }> {
  const announce: string[] = [];
  const seen = new Set<string>();

  for (const finding of findings) {
    seen.add(`${finding.rule}|${finding.subject}`);
    const [row] = await rows<{ id: string; inserted: boolean }>(
      db,
      `insert into monitor_alerts
         (rule, subject, severity, level, detail, notify_attempted_at, notify_until)
       values ($1, $2, $3, $4, $5, now(), now() + $6::interval)
       on conflict (rule, subject) where resolved_at is null
       do update set last_seen_at = now(), absent_evaluations = 0, detail = excluded.detail
       returning id::text, (xmax = 0) as inserted`,
      [finding.rule, finding.subject, finding.severity, finding.level, finding.detail, RETRY_FOR],
    );
    if (!row) continue;
    if (row.inserted) {
      announce.push(row.id);
    } else if (finding.level > 0 && (await levelRose(db, row.id, finding.level))) {
      announce.push(row.id);
    }
  }

  const absent = openAlerts
    .filter((alert) => !seen.has(`${alert.rule}|${alert.subject}`))
    .map((alert) => alert.id);
  if (absent.length === 0) return { announce, recover: [] };

  const resolved = await rows<{ id: string; announced: boolean }>(
    db,
    `update monitor_alerts
     set absent_evaluations = absent_evaluations + 1,
         resolved_at = case when absent_evaluations + 1 >= $2 then now() end,
         recovery_attempted_at = case when absent_evaluations + 1 >= $2 then now() end
     where id = any($1::bigint[]) and resolved_at is null
     returning id::text, resolved_at is not null and notified_at is not null as announced`,
    [absent, RESOLVE_AFTER_ABSENT],
  );
  return { announce, recover: resolved.filter((r) => r.announced).map((r) => r.id) };
}

/**
 * Moves an open alert to `level` and says whether that was a rise. A fall is
 * recorded quietly, so the next rise is measured from where the problem
 * actually is. The row lock makes two evaluations seeing the same rise agree
 * on which of them moved it.
 */
async function levelRose(db: Db, id: string, level: number): Promise<boolean> {
  const [row] = await rows<{ rose: boolean }>(
    db,
    `update monitor_alerts a
     set level = $2::int,
         notified_at = case when $2::int > old.level then null else a.notified_at end,
         notify_attempted_at = case when $2::int > old.level then now() else a.notify_attempted_at end,
         notify_until = case when $2::int > old.level then now() + $3::interval else a.notify_until end
     from (select id, level from monitor_alerts where id = $1::bigint for update) old
     where a.id = old.id and a.level <> $2::int
     returning old.level < $2::int as rose`,
    [id, level, RETRY_FOR],
  );
  return row?.rose ?? false;
}

type AlertRow = {
  id: string;
  rule: string;
  severity: Severity;
  opened_at: Date;
  resolved_at: Date | null;
  detail: AlertDetail;
};

const ALERT_COLUMNS = "id::text, rule, severity, opened_at, resolved_at, detail";

function toAlert(row: AlertRow): AlertForMessage {
  return {
    id: row.id,
    rule: row.rule,
    severity: row.severity,
    openedAt: row.opened_at.getTime(),
    resolvedAt: row.resolved_at?.getTime() ?? null,
    detail: row.detail,
  };
}

export async function alertsById(ids: readonly string[]): Promise<AlertForMessage[]> {
  if (ids.length === 0) return [];
  const rows = await query<AlertRow>(
    `select ${ALERT_COLUMNS} from monitor_alerts where id = any($1::bigint[]) order by id`,
    [ids],
  );
  return rows.map(toAlert);
}

export async function markAnnounced(id: string): Promise<void> {
  await query("update monitor_alerts set notified_at = now() where id = $1", [id]);
}

export async function markRecoveryAnnounced(id: string): Promise<void> {
  await query("update monitor_alerts set recovery_notified_at = now() where id = $1", [id]);
}

/**
 * Posts an earlier evaluation won but could not deliver, claimed so two
 * evaluations cannot both retry one. Retry openings before recoveries: a
 * recovery is only ever posted for an alert whose opening got through, so an
 * alert that came and went while Discord was down does not arrive as a lone
 * "recovered".
 */
export async function claimAnnounceRetries(): Promise<AlertForMessage[]> {
  const rows = await query<AlertRow>(
    `update monitor_alerts set notify_attempted_at = now()
     where notified_at is null
       and coalesce(notify_attempted_at, '-infinity') < now() - $1::interval
       and notify_until > now()
     returning ${ALERT_COLUMNS}`,
    [RETRY_AFTER],
  );
  return rows.map(toAlert);
}

export async function claimRecoveryRetries(): Promise<AlertForMessage[]> {
  const rows = await query<AlertRow>(
    `update monitor_alerts set recovery_attempted_at = now()
     where resolved_at is not null and recovery_notified_at is null
       and notified_at is not null
       and coalesce(recovery_attempted_at, '-infinity') < now() - $1::interval
       and resolved_at > now() - $2::interval
     returning ${ALERT_COLUMNS}`,
    [RETRY_AFTER, RETRY_FOR],
  );
  return rows.map(toAlert);
}

/**
 * Deletes heartbeats past HEARTBEAT_RETENTION, at most once per PRUNE_EVERY -
 * the claim and the delete are one statement, so concurrent evaluations
 * cannot both prune. Returns the rows deleted, or null when it was not due.
 */
export async function pruneHeartbeats(): Promise<number | null> {
  const row = await queryOne<{ due: boolean; deleted: number }>(
    `with claimed as (
       update monitor_state set last_pruned_at = now()
       where id = 1 and (last_pruned_at is null or last_pruned_at < now() - $1::interval)
       returning id
     ),
     pruned as (
       delete from rig_heartbeats
       where received_at < now() - $2::interval and exists (select 1 from claimed)
       returning 1
     )
     select exists (select 1 from claimed) as due, (select count(*) from pruned)::int as deleted`,
    [PRUNE_EVERY, HEARTBEAT_RETENTION],
  );
  return row?.due ? row.deleted : null;
}

export async function countOpenAlerts(): Promise<number> {
  const row = await queryOne<{ open: number }>(
    "select count(*)::int as open from monitor_alerts where resolved_at is null",
  );
  return row?.open ?? 0;
}

/**
 * The AI diagnosis of an urgent alert, kept in monitor_alerts.diagnosis:
 *
 *   pending  a call is in flight (claimed by one evaluation)
 *   retry    the call failed; the next evaluation after RETRY_AFTER tries again
 *   done     there is a result, or the retry failed too - either way the
 *            handoff is written and only the posting is left
 *
 * `attempts` counts calls; `diagnosisPostedAt` and `handoffPostedAt` record
 * the two messages separately, so a post that fails half way is finished
 * later without the half that got through being posted twice.
 */
export type DiagnosisState = {
  status: "pending" | "retry" | "done";
  attempts: number;
  provider?: string;
  model?: string;
  error?: string;
  result?: unknown;
  diagnosisPostedAt?: string;
  handoffPostedAt?: string;
};

/** A call that never reported back (its function died) is retried after this. */
const DIAGNOSIS_STALE = "2 minutes";
/** Calls claimed per evaluation: each can take the provider's whole timeout. */
const DIAGNOSES_PER_EVALUATION = 3;

export type AlertToDiagnose = AlertForMessage & { subject: string; attempts: number };

/**
 * Claims the urgent alerts that need a diagnosis call: announced (so the
 * alert itself always goes first), still open, and never diagnosed, due a
 * retry, or claimed by a call that went quiet. One statement, and SKIP LOCKED,
 * so two evaluations cannot both call for one alert.
 */
export async function claimDiagnoses(): Promise<AlertToDiagnose[]> {
  const rows = await query<AlertRow & { subject: string; attempts: number }>(
    `update monitor_alerts a
     set diagnosis = jsonb_build_object(
       'status', 'pending',
       'attempts', coalesce((a.diagnosis->>'attempts')::int, 0) + 1,
       'at', now())
     where a.id in (
       select id from monitor_alerts
       where severity = 'urgent' and notified_at is not null and resolved_at is null
         and opened_at > now() - $1::interval
         and (diagnosis is null
           or (diagnosis->>'status' = 'retry' and (diagnosis->>'at')::timestamptz < now() - $2::interval)
           or (diagnosis->>'status' = 'pending' and (diagnosis->>'at')::timestamptz < now() - $3::interval))
       order by id
       limit $4
       for update skip locked)
     returning ${ALERT_COLUMNS}, subject, (diagnosis->>'attempts')::int as attempts`,
    [RETRY_FOR, RETRY_AFTER, DIAGNOSIS_STALE, DIAGNOSES_PER_EVALUATION],
  );
  return rows.map((row) => ({ ...toAlert(row), subject: row.subject, attempts: row.attempts }));
}

/** A rig's latest heartbeats, newest first, for the diagnosis to read. */
export async function recentHeartbeats(subject: string): Promise<DiagnosisHeartbeat[]> {
  const rigId = subject.match(/^rig:([0-9a-f-]{36})$/i)?.[1];
  if (!rigId) return [];
  const rows = await query<{ received_ms: number; clock_skew_ms: number | null; payload: Record<string, unknown> }>(
    `select (extract(epoch from received_at) * 1000)::float8 as received_ms,
            clock_skew_ms::float8 as clock_skew_ms, payload
     from rig_heartbeats where rig_id = $1 order by received_at desc, id desc limit 15`,
    [rigId],
  );
  return rows.map((r) => ({ receivedAt: r.received_ms, clockSkewMs: r.clock_skew_ms, payload: r.payload }));
}

/**
 * Stores a call's outcome. A `done` state also claims its posting, so the
 * evaluation that made the call posts it and a retry sweep does not race it.
 */
export async function saveDiagnosis(id: string, state: DiagnosisState, handoff: string | null): Promise<void> {
  await query(
    `update monitor_alerts
     set diagnosis = $2::jsonb || jsonb_build_object('at', now()) ||
                     case when $2::jsonb->>'status' = 'done'
                          then jsonb_build_object('postAttemptedAt', now()) else '{}'::jsonb end,
         handoff = $3
     where id = $1`,
    [id, JSON.stringify(state), handoff],
  );
}

export async function markDiagnosisPosted(
  id: string,
  which: "diagnosisPostedAt" | "handoffPostedAt",
): Promise<void> {
  await query(
    "update monitor_alerts set diagnosis = diagnosis || jsonb_build_object($2::text, now()) where id = $1",
    [id, which],
  );
}

export type DiagnosisToPost = { id: string; diagnosis: DiagnosisState; handoff: string; alert: AlertForMessage };

/** Diagnosis messages an earlier evaluation could not post, claimed as the alert retries are. */
export async function claimDiagnosisPostRetries(): Promise<DiagnosisToPost[]> {
  const rows = await query<AlertRow & { diagnosis: DiagnosisState; handoff: string }>(
    `update monitor_alerts
     set diagnosis = diagnosis || jsonb_build_object('postAttemptedAt', now())
     where diagnosis->>'status' = 'done' and handoff is not null
       and diagnosis->>'handoffPostedAt' is null
       and coalesce((diagnosis->>'postAttemptedAt')::timestamptz, '-infinity') < now() - $1::interval
       and opened_at > now() - $2::interval
     returning ${ALERT_COLUMNS}, diagnosis, handoff`,
    [RETRY_AFTER, RETRY_FOR],
  );
  return rows.map((row) => ({ id: row.id, diagnosis: row.diagnosis, handoff: row.handoff, alert: toAlert(row) }));
}
