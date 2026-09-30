import type { QueryResult, QueryResultRow } from "pg";
import { query, queryOne } from "@/lib/db";
import type { HeartbeatRow as DiagnosisHeartbeat } from "./diagnosis/context";
import type { AlertForMessage } from "./messages";
import type { Heartbeat } from "./rig-state";
import {
  HEARD_HISTORY_MS,
  LAP_HISTORY_MS,
  MOVE_WINDOW_MS,
  RECOVERS_SILENTLY,
  SILENT_AFTER_MS,
  type AlertDetail,
  type FeaturedCombo,
  type Finding,
  type LapSnapshot,
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

/**
 * Flapping. An alert that opens for the FLAPPING_REFIRES-th time on the same
 * rule and subject within FLAPPING_WINDOW - three re-fires after the first -
 * posts one "flapping, muted" line instead of itself, and starts a mute that
 * ends FLAPPING_WINDOW after it. Everything on that rule and subject until then
 * (openings, recoveries, rises) is kept but not posted. monitor_alerts.
 * refire_count records how many earlier openings each alert had in the window
 * before it, and never less than FLAPPING_REFIRES for one that opened inside a
 * mute.
 *
 * A muted alert's own opening is not dropped but deferred to the mute's end:
 * its notify window starts there, so notify_until is the mute's end plus
 * RETRY_FOR - the one thing that says an alert is muted (MUTED), and shared by
 * every alert of one mute. Once the mute ends, the retry sweep posts each one
 * still open with its current state, and from then on it rises and recovers
 * like any other; one that closed inside the mute is never posted, since its
 * notify window began after it closed. The alerts stay open and visible; the
 * mute only keeps the channel quiet.
 */
export const FLAPPING_REFIRES = 3;
const FLAPPING_WINDOW = "1 hour";

/** Whether an alert is inside a flapping mute right now (see FLAPPING_REFIRES). */
const MUTED = `(refire_count >= ${FLAPPING_REFIRES} and notify_until > now() + interval '${RETRY_FOR}')`;

/**
 * How far before now a lap's completed_at (the rig's clock) may be for the
 * snapshot to read it, which lets the read use laps_tonight_idx rather than
 * scan every lap ever stored. Laps flushed after a longer outage, or from a
 * rig whose clock is over this far behind (rule 12), are not judged by rules
 * 5a, 7 and 14 - they describe what was driven hours ago, not now.
 */
const LAPS_DRIVEN_WITHIN = "1 hour";

/**
 * Laps stored in the last LAP_HISTORY_MS ($2), each with its driver. The
 * completed_at bound ($1), with both values of is_valid named, is what makes
 * this a range on laps_tonight_idx (is_valid, completed_at) rather than a
 * scan of every lap ever stored; an integration test counts the rows it
 * reads.
 */
export const RECENT_LAPS_SQL = `
  select l.id::text, l.rig_id::text, l.created_at, l.driver_id::text,
         d.display_name::text as driver_name, d.status::text as driver_status,
         l.track_name, l.track_config, l.car_name, l.lap_time_ms, l.is_valid,
         l.invalid_reason::text, l.unattributed_cause::text
  from laps l
  left join drivers d on d.id = l.driver_id
  where l.is_valid = any (array[true, false])
    and l.completed_at >= now() - $1::interval
    and l.created_at >= now() - $2::interval
  order by l.created_at, l.id`;

/**
 * Rule 14's reference: per driver, the best valid lap stored before those
 * recent laps, on each car and track one of them was a valid lap on, folded
 * to one row per driver - and nothing at all when no valid lap is recent. It
 * reads only those combos' laps, each a range on laps_combo_idx: a missing
 * layout and an empty one are the same combo, as ingestion treats them, so
 * the empty one is looked up both ways rather than through a coalesce the
 * index cannot use, and comes back as ''.
 */
export const LAP_BESTS_SQL = `
  with recent as (
    select distinct track_name, coalesce(track_config, '') as track_config, car_name
    from laps
    where is_valid and driver_id is not null
      and completed_at >= now() - $1::interval and created_at >= now() - $2::interval
  )
  select r.track_name, r.track_config, r.car_name, l.driver_id::text, min(l.lap_time_ms) as best_ms
  from recent r
  cross join lateral (
    select driver_id, lap_time_ms, created_at from laps
    where track_name = r.track_name and track_config = r.track_config
      and car_name = r.car_name and is_valid
    union all
    select driver_id, lap_time_ms, created_at from laps
    where r.track_config = '' and track_name = r.track_name and track_config is null
      and car_name = r.car_name and is_valid
  ) l
  where l.driver_id is not null and l.created_at < now() - $2::interval
  group by r.track_name, r.track_config, r.car_name, l.driver_id`;

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
  const [rigRows, heartbeatRows, heardRows, openAlerts, [venue], lapRows, bestRows, moveRows] = await Promise.all([
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
              h.session_track, h.session_config, h.session_car, h.sign_in_failures,
              h.payload->'signInFailureKinds' as sign_in_failure_kinds,
              h.payload->'signInFailureSeqs' as sign_in_failure_seqs,
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
    rows<{
      long_stint_minutes: number | null;
      track_name: string | null;
      track_config: string | null;
      car_name: string | null;
    }>(
      db,
      `select (select long_stint_minutes from monitor_state where id = 1) as long_stint_minutes,
              fc.track_name, fc.track_config, fc.car_name
       from (select 1) one
       left join featured_combos fc on fc.combo_date = venue_today()`,
    ),
    rows<LapRow>(db, RECENT_LAPS_SQL, [LAPS_DRIVEN_WITHIN, `${LAP_HISTORY_MS / 1000} seconds`]),
    rows<{ track_name: string; track_config: string; car_name: string; driver_id: string; best_ms: number }>(
      db,
      LAP_BESTS_SQL,
      [LAPS_DRIVEN_WITHIN, `${LAP_HISTORY_MS / 1000} seconds`],
    ),
    rows<{
      from_rig_id: string;
      to_rig_id: string | null;
      ended_at: Date;
      driver_name: string;
      driver_status: string;
    }>(
      db,
      `select ra.rig_id::text as from_rig_id, now_on.rig_id::text as to_rig_id, ra.ended_at,
              d.display_name::text as driver_name, d.status::text as driver_status
       from rig_assignments ra
       join drivers d on d.id = ra.driver_id
       left join rig_assignments now_on on now_on.driver_id = ra.driver_id and now_on.ended_at is null
       where ra.end_reason = 'moved' and ra.ended_at >= now() - $1::interval`,
      [`${MOVE_WINDOW_MS / 1000} seconds`],
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

  return {
    now,
    rigs,
    featuredCombo:
      venue?.track_name && venue.car_name
        ? { trackName: venue.track_name, trackConfig: venue.track_config, carName: venue.car_name }
        : null,
    longStintMinutes: venue?.long_stint_minutes ?? 120,
    laps: lapRows.map(toLap),
    lapBests: bestRows.map((row) => ({
      combo: { trackName: row.track_name, trackConfig: row.track_config || null, carName: row.car_name },
      driverId: row.driver_id,
      lapTimeMs: row.best_ms,
    })),
    moves: moveRows.map((row) => ({
      fromRigId: row.from_rig_id,
      toRigId: row.to_rig_id,
      endedAt: row.ended_at.getTime(),
      driverName: row.driver_name,
      driverStatus: row.driver_status,
    })),
    openAlerts,
  };
}

type LapRow = {
  id: string;
  rig_id: string;
  created_at: Date;
  driver_id: string | null;
  driver_name: string | null;
  driver_status: string | null;
  track_name: string;
  track_config: string | null;
  car_name: string;
  lap_time_ms: number;
  is_valid: boolean;
  invalid_reason: string | null;
  unattributed_cause: string | null;
};

function toLap(row: LapRow): LapSnapshot {
  const combo: FeaturedCombo = {
    trackName: row.track_name,
    trackConfig: row.track_config,
    carName: row.car_name,
  };
  return {
    id: row.id,
    rigId: row.rig_id,
    receivedAt: row.created_at.getTime(),
    driver:
      row.driver_id && row.driver_name && row.driver_status
        ? { id: row.driver_id, name: row.driver_name, status: row.driver_status }
        : null,
    combo,
    lapTimeMs: row.lap_time_ms,
    valid: row.is_valid,
    invalidReason: row.invalid_reason,
    unattributedCause: row.unattributed_cause,
  };
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
  session_track: string | null;
  session_config: string | null;
  session_car: string | null;
  sign_in_failures: number | null;
  sign_in_failure_kinds: unknown;
  sign_in_failure_seqs: unknown;
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
    session:
      row.session_track && row.session_car
        ? { trackName: row.session_track, trackConfig: row.session_config, carName: row.session_car }
        : null,
    pendingLaps: row.pending_laps,
    oldestPendingAgeS: row.oldest_pending_age_s,
    rejectedLaps: row.rejected_laps,
    checkout: row.checkout,
    signInFailures: row.sign_in_failures,
    signInFailureKinds: Array.isArray(row.sign_in_failure_kinds)
      ? row.sign_in_failure_kinds.filter((kind): kind is string => typeof kind === "string")
      : [],
    signInFailureSeqs: Array.isArray(row.sign_in_failure_seqs)
      ? row.sign_in_failure_seqs.filter((seq): seq is number => typeof seq === "number")
      : null,
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
 * - Open: a problem already open only has its last_seen_at, detail and
 *   absence count refreshed, found through monitor_alerts_one_open. Otherwise
 *   it is inserted, and only the evaluation whose row was inserted announces;
 *   counting its earlier openings reads the rule's alert history, so only a
 *   new opening pays for it. An opening that starts a flapping mute announces
 *   the mute instead (FLAPPING_REFIRES); one inside a mute announces nothing
 *   now, and its opening is due when the mute ends.
 * - Worse: a finding whose level rose re-announces once per rise, claimed by
 *   the update that moved the level - unless the alert is muted.
 * - Recover: an open alert no finding named counts one absence; the evaluation
 *   whose update reaches RESOLVE_AFTER_ABSENT resolves it and posts, if its
 *   opening was posted (a muted one's never was) and its rule does not recover
 *   silently (RECOVERS_SILENTLY).
 *
 * Evaluations run one at a time (the monitor_state lock), so the count of
 * earlier openings an insert reads cannot race another evaluation's insert.
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
    const [open] = await rows<{ id: string }>(
      db,
      `update monitor_alerts
       set last_seen_at = now(), absent_evaluations = 0, detail = $3
       where rule = $1 and subject = $2 and resolved_at is null
       returning id::text`,
      [finding.rule, finding.subject, finding.detail],
    );
    if (open) {
      if (finding.level > 0 && (await levelRose(db, open.id, finding.level))) announce.push(open.id);
      continue;
    }
    const [row] = await rows<{ id: string; silent: boolean }>(
      db,
      `with earlier as (
         select count(*)::int as openings, max(notify_until) filter (where ${MUTED}) as mute_deadline
         from monitor_alerts
         where rule = $1 and subject = $2 and opened_at > now() - $8::interval
       )
       insert into monitor_alerts
         (rule, subject, severity, level, detail, refire_count, notify_attempted_at, notify_until)
       select $1, $2, $3, $4, $5,
              case when mute_deadline is null then openings else greatest(openings, $7) end,
              coalesce(mute_deadline - $6::interval, now()),
              case when mute_deadline is not null then mute_deadline
                   when openings >= $7 then now() + $8::interval + $6::interval
                   else now() + $6::interval end
       from earlier
       on conflict (rule, subject) where resolved_at is null do nothing
       returning id::text, notify_attempted_at > now() as silent`,
      [
        finding.rule,
        finding.subject,
        finding.severity,
        finding.level,
        finding.detail,
        RETRY_FOR,
        FLAPPING_REFIRES,
        FLAPPING_WINDOW,
      ],
    );
    if (row && !row.silent) announce.push(row.id);
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
     returning id::text,
               resolved_at is not null and notified_at is not null
                 and rule <> all($3::text[]) as announced`,
    [absent, RESOLVE_AFTER_ABSENT, RECOVERS_SILENTLY],
  );
  return { announce, recover: resolved.filter((r) => r.announced).map((r) => r.id) };
}

/**
 * Moves an open alert to `level` and says whether that was a rise to post. A
 * fall is recorded quietly, so the next rise is measured from where the
 * problem actually is, and so is a rise while the alert is muted. The row
 * lock makes two evaluations seeing the same rise agree on which of them
 * moved it.
 */
async function levelRose(db: Db, id: string, level: number): Promise<boolean> {
  const [row] = await rows<{ rose: boolean }>(
    db,
    `update monitor_alerts a
     set level = $2::int,
         notified_at = case when old.posts then null else a.notified_at end,
         notify_attempted_at = case when old.posts then now() else a.notify_attempted_at end,
         notify_until = case when old.posts then now() + $3::interval else a.notify_until end
     from (select id, level, $2::int > level and not ${MUTED} as posts
           from monitor_alerts where id = $1::bigint for update) old
     where a.id = old.id and a.level <> $2::int
     returning old.posts as rose`,
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
  refire_count: number;
  muted: boolean;
  detail: AlertDetail;
};

const ALERT_COLUMNS = `id::text, rule, severity, opened_at, resolved_at, refire_count, ${MUTED} as muted, detail`;

function toAlert(row: AlertRow): AlertForMessage {
  return {
    id: row.id,
    rule: row.rule,
    severity: row.severity,
    openedAt: row.opened_at.getTime(),
    resolvedAt: row.resolved_at?.getTime() ?? null,
    refireCount: row.refire_count,
    flapping: row.muted,
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

/**
 * Records a posted opening. A flapping line is not the alert's opening: it
 * only moves the next attempt to the mute's end, where the opening is due.
 */
export async function markAnnounced(alert: AlertForMessage): Promise<void> {
  await query(
    alert.flapping
      ? "update monitor_alerts set notify_attempted_at = notify_until - $2::interval where id = $1"
      : "update monitor_alerts set notified_at = now() where id = $1",
    alert.flapping ? [alert.id, RETRY_FOR] : [alert.id],
  );
}

export async function markRecoveryAnnounced(alert: AlertForMessage): Promise<void> {
  await query("update monitor_alerts set recovery_notified_at = now() where id = $1", [alert.id]);
}

/**
 * Posts an earlier evaluation won but could not deliver, claimed so two
 * evaluations cannot both retry one. Retry openings before recoveries: a
 * recovery is only ever posted for an alert whose opening got through, so an
 * alert that came and went while Discord was down does not arrive as a lone
 * "recovered". The same sweep posts a muted alert's opening once its mute has
 * ended, unless it closed inside the mute, before its opening was due.
 */
export async function claimAnnounceRetries(): Promise<AlertForMessage[]> {
  const rows = await query<AlertRow>(
    `update monitor_alerts set notify_attempted_at = now()
     where notified_at is null
       and coalesce(notify_attempted_at, '-infinity') < now() - $1::interval
       and notify_until > now()
       and (resolved_at is null or resolved_at >= notify_until - $2::interval)
     returning ${ALERT_COLUMNS}`,
    [RETRY_AFTER, RETRY_FOR],
  );
  return rows.map(toAlert);
}

export async function claimRecoveryRetries(): Promise<AlertForMessage[]> {
  const rows = await query<AlertRow>(
    `update monitor_alerts set recovery_attempted_at = now()
     where resolved_at is not null and recovery_notified_at is null
       and notified_at is not null
       and rule <> all($3::text[])
       and coalesce(recovery_attempted_at, '-infinity') < now() - $1::interval
       and resolved_at > now() - $2::interval
     returning ${ALERT_COLUMNS}`,
    [RETRY_AFTER, RETRY_FOR, RECOVERS_SILENTLY],
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
 * Claims the urgent alerts that need a diagnosis call: announced in the last
 * RETRY_FOR (so the alert itself always goes first - a muted one only once
 * its mute has ended), still open, and never diagnosed, due a retry, or
 * claimed by a call that went quiet. A rig alert whose detail does not say
 * who was seated (stored before AlertDetail.driver existed) is never claimed,
 * since its text may name a driver the redaction cannot know. One statement,
 * and SKIP LOCKED, so two evaluations cannot both call for one alert.
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
       where severity = 'urgent' and notified_at > now() - $1::interval and resolved_at is null
         and (subject not like 'rig:%' or detail ? 'driver')
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

/**
 * A rig's latest heartbeats, newest first, for the diagnosis to read. The
 * ingestion route stores the fields the rules filter on in their own columns
 * and only the rest in `payload`, so the columns are put back under their
 * wire names here. A null column is a field the heartbeat did not carry,
 * except `assignment_id`: a current agent always says whether anyone is
 * seated (`assignmentKnown`), so there null means nobody.
 */
export async function recentHeartbeats(subject: string): Promise<DiagnosisHeartbeat[]> {
  const rigId = subject.match(/^rig:([0-9a-f-]{36})$/i)?.[1];
  if (!rigId) return [];
  const rows = await query<{ received_ms: number; clock_skew_ms: number | null; payload: Record<string, unknown> }>(
    `select (extract(epoch from received_at) * 1000)::float8 as received_ms,
            clock_skew_ms::float8 as clock_skew_ms,
            payload || jsonb_strip_nulls(jsonb_build_object(
              'agentVersion', agent_version,
              'processStartedAt', process_started_at,
              'startCount', start_count,
              'simConnected', sim_connected,
              'telemetryFaulted', telemetry_faulted,
              'session', case when session_track is not null then jsonb_build_object(
                'trackName', session_track, 'trackConfig', session_config, 'carName', session_car) end,
              'pendingLaps', pending_laps,
              'rejectedLaps', rejected_laps,
              'checkout', checkout,
              'signInFailures', sign_in_failures,
              'shuttingDown', case when shutting_down then true end))
            || case when assignment_id is not null or (payload->>'assignmentKnown')::boolean
                    then jsonb_build_object('assignmentId', assignment_id) else '{}'::jsonb end
              as payload
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

/**
 * Diagnosis messages an earlier evaluation could not post, claimed as the alert
 * retries are, for RETRY_FOR after the diagnosis was made.
 */
export async function claimDiagnosisPostRetries(): Promise<DiagnosisToPost[]> {
  const rows = await query<AlertRow & { diagnosis: DiagnosisState; handoff: string }>(
    `update monitor_alerts
     set diagnosis = diagnosis || jsonb_build_object('postAttemptedAt', now())
     where diagnosis->>'status' = 'done' and handoff is not null
       and diagnosis->>'handoffPostedAt' is null
       and coalesce((diagnosis->>'postAttemptedAt')::timestamptz, '-infinity') < now() - $1::interval
       and (diagnosis->>'at')::timestamptz > now() - $2::interval
     returning ${ALERT_COLUMNS}, diagnosis, handoff`,
    [RETRY_AFTER, RETRY_FOR],
  );
  return rows.map((row) => ({ id: row.id, diagnosis: row.diagnosis, handoff: row.handoff, alert: toAlert(row) }));
}
