import { after } from "next/server";
import { withTransaction } from "@/lib/db";
import { diagnose, diagnosisConfig, diagnosisSchema, type DiagnosisConfig } from "./diagnosis";
import { incidentContext } from "./diagnosis/context";
import type { ProviderName } from "./diagnosis/provider";
import { alertUserId, discordConfigured, postDiscord } from "./discord";
import {
  commentMarkers,
  commentOnIssue,
  findIssueWithMarker,
  githubConfigured,
  openIssue,
  reopenIssue,
  type GitHubResult,
} from "./github";
import {
  diagnosisMessage,
  handoffMessage,
  handoffText,
  markedAlerts,
  recoveryComment,
  refireComment,
  rigAlertIssue,
} from "./handoff";
import { alertMessage, recoveryMessage, type AlertForMessage } from "./messages";
import { evaluateRules, RULES } from "./rules";
import {
  alertsById,
  applyFindings,
  claimAnnounceRetries,
  claimDiagnoses,
  claimDiagnosisPostRetries,
  claimEvaluation,
  claimIssueRecoveries,
  claimIssues,
  claimRecoveryRetries,
  loadSnapshot,
  lockFault,
  markAnnounced,
  markDiagnosisPosted,
  markRecoveryAnnounced,
  pruneHeartbeats,
  recentHeartbeats,
  recordIssue,
  refireTarget,
  saveDiagnosis,
  unfiledAlerts,
  type AlertToDiagnose,
  type AlertToFile,
  type DiagnosisState,
} from "./store";

/** Calls per alert: the first, and one retry (plan section 10). */
export const DIAGNOSIS_ATTEMPTS = 2;

/**
 * How far before an alert opened its marker is looked for: past any clock
 * difference between this database and GitHub.
 */
const MARKER_LOOKBACK_MS = 60 * 60_000;

/**
 * Rules where software is a plausible cause: their urgent alerts get an issue
 * whatever the diagnosis says - once there is a handoff to file, which needs
 * the diagnosis key and the Discord webhook.
 */
const SOFTWARE_RULES = Object.entries(RULES)
  .filter(([, rule]) => rule.software)
  .map(([key]) => key);

/**
 * One monitor evaluation, end to end: claim it, read the snapshot, run the
 * rules, apply the transitions, post what this evaluation won, retry what an
 * earlier one could not deliver, and prune old heartbeats when that is due.
 * Urgent alerts' diagnoses are a separate stage, runDiagnoses, which follows
 * an evaluation that ran and never delays its answer.
 *
 * Nothing runs it on a timer inside Vercel (Hobby cron is once a day). It
 * runs after every rig heartbeat's response has gone (scheduleMonitor) and on
 * every GET /api/monitor/tick from the external one-minute clock, and the
 * claim throttles all of them to one evaluation every few seconds, run one
 * at a time.
 */
export type MonitorRun =
  | { evaluated: false }
  | { evaluated: true; findings: number; announced: number; recovered: number };

export async function runMonitor(): Promise<MonitorRun> {
  // Claim, snapshot, rules and transitions in one short transaction holding
  // the monitor_state row lock, so evaluations apply in the order they read
  // (store.ts). It commits before anything is posted: no Discord call ever
  // holds the lock.
  const evaluation = await withTransaction(async (client) => {
    const claim = await claimEvaluation(client);
    if (!claim) return null;
    const snapshot = await loadSnapshot(client, claim.now);
    const findings = evaluateRules(snapshot);
    const won = await applyFindings(client, findings, snapshot.openAlerts);
    return { findings, won };
  });
  if (!evaluation) return { evaluated: false };
  const { findings, won } = evaluation;

  const mention = alertUserId();
  let announced = await deliver(await alertsById(won.announce), (a) => alertMessage(a, mention), markAnnounced);
  let recovered = await deliver(await alertsById(won.recover), recoveryMessage, markRecoveryAnnounced);
  // Without a webhook nothing was sent and nothing will be, so there is
  // nothing to retry - and a preview must not keep claiming the posts that
  // production's evaluations should make.
  if (discordConfigured()) {
    announced += await deliver(await claimAnnounceRetries(), (a) => alertMessage(a, mention), markAnnounced);
    recovered += await deliver(await claimRecoveryRetries(), recoveryMessage, markRecoveryAnnounced);
  }

  const pruned = await pruneHeartbeats();
  if (pruned !== null) console.log(`[monitor] pruned ${pruned} heartbeat(s) past retention`);

  return { evaluated: true, findings: findings.length, announced, recovered };
}

/**
 * Urgent alerts' diagnoses and handoffs, the retry of any that Discord
 * refused, and the rig-alert issues filed from those handoffs. Runs after an
 * evaluation, so every alert and recovery has had its turn first and a slow
 * or failing model delays nothing; the claims keep two concurrent runs from
 * diagnosing or posting the same alert. Returns how many diagnoses were made.
 */
export async function runDiagnoses(): Promise<number> {
  if (!discordConfigured()) return 0;
  let diagnosed = 0;
  const config = diagnosisConfig();
  if (config) {
    for (const alert of await claimDiagnoses()) {
      if (await diagnoseAlert(alert, config)) diagnosed++;
    }
  }
  for (const row of await claimDiagnosisPostRetries()) {
    await postDiagnosis(row.alert, row.diagnosis, row.handoff);
  }

  // The rig-alert issue comes last: it carries the handoff written above, and
  // a slow GitHub delays no Discord post. Without a token nothing is claimed
  // and the Discord handoff is the whole story.
  if (githubConfigured()) {
    for (const alerts of groupBy(await claimIssues(SOFTWARE_RULES), (alert) => alert.rule)) await fileIssue(alerts);
    for (const alerts of groupBy(await claimIssueRecoveries(SOFTWARE_RULES), (alert) => alert.issue)) {
      await commentRecovery(alerts[0]!.issue, alerts);
    }
  }
  return diagnosed;
}

/**
 * Posts each message in turn - sequentially, so a burst of alerts stays inside
 * Discord's per-webhook rate limit - and records each one Discord took. A post
 * that fails stays unrecorded for a later evaluation to retry.
 */
async function deliver(
  alerts: AlertForMessage[],
  render: (alert: AlertForMessage) => Parameters<typeof postDiscord>[0],
  record: (id: string) => Promise<void>,
): Promise<number> {
  let sent = 0;
  for (const alert of alerts) {
    const result = await postDiscord(render(alert));
    if (result.status === "sent") {
      await record(alert.id);
      sent++;
    } else if (result.status === "failed") {
      console.error(`[monitor] could not post alert #${alert.id} to Discord: ${result.reason}`);
    }
  }
  return sent;
}

/**
 * One diagnosis call for an urgent alert, then its two messages. A failure
 * stores a retry marker and the next evaluation tries once more; after that
 * the handoff is posted without the model's lines, since the owner still
 * wants something to paste. Returns whether a diagnosis was made.
 */
async function diagnoseAlert(alert: AlertToDiagnose, config: DiagnosisConfig): Promise<boolean> {
  const context = await contextOf(alert);
  const base = { provider: config.provider, model: config.model };
  // Past the attempts only when a claimed call never reported back.
  const result =
    alert.attempts > DIAGNOSIS_ATTEMPTS
      ? ({ ok: false, error: "the call never finished" } as const)
      : await diagnose(context, config);

  if (!result.ok && alert.attempts < DIAGNOSIS_ATTEMPTS) {
    console.error(`[monitor] diagnosis of alert #${alert.id} failed, will retry: ${result.error}`);
    await saveDiagnosis(alert.id, { ...base, status: "retry", attempts: alert.attempts, error: result.error }, null);
    return false;
  }
  if (!result.ok) console.error(`[monitor] diagnosis of alert #${alert.id} failed: ${result.error}`);

  const state: DiagnosisState = result.ok
    ? { ...base, status: "done", attempts: alert.attempts, result: result.diagnosis }
    : { ...base, status: "done", attempts: alert.attempts, error: result.error };
  const handoff = handoffText(context, result);
  await saveDiagnosis(alert.id, state, handoff);
  await postDiagnosis(alert, state, handoff);
  return result.ok;
}

/**
 * Posts whichever of the diagnosis and the handoff have not gone yet, in that
 * order; stops at the first failure, which a later evaluation retries.
 */
async function postDiagnosis(alert: AlertForMessage, state: DiagnosisState, handoff: string): Promise<void> {
  const diagnosis = diagnosisSchema.safeParse(state.result);
  if (diagnosis.success && !state.diagnosisPostedAt) {
    const sent = await postDiscord(diagnosisMessage(alert, diagnosis.data, state.provider as ProviderName));
    if (sent.status !== "sent") return logFailedPost(alert.id, sent);
    await markDiagnosisPosted(alert.id, "diagnosisPostedAt");
  }
  if (!state.handoffPostedAt) {
    const sent = await postDiscord(handoffMessage(handoff));
    if (sent.status !== "sent") return logFailedPost(alert.id, sent);
    await markDiagnosisPosted(alert.id, "handoffPostedAt");
  }
}

/**
 * Files one rule's claimed alerts: opens the rule's rig-alert issue, or - when
 * an alert of the same rule within a day, on any rig, already has one -
 * comments on that one instead, reopening it if it was closed, so one fault
 * makes one issue however many rigs it hits and one comment however many of
 * them join at once. The heartbeats are the ones each handoff was written
 * from, not any received since.
 *
 * Runs under the rule's lock (lockFault), from the issue lookup to the
 * record, so concurrent filers of one rule cannot open two issues; a filer
 * that finds it held leaves its alerts for a later evaluation. And each write
 * is looked for by its marker first, so a write whose answer was lost is
 * recorded, not repeated. A failure is retried by a later evaluation.
 */
async function fileIssue(claimed: AlertToFile[]): Promise<void> {
  const rule = claimed[0]!.rule;
  const prepared = await Promise.all(
    claimed.map(async (alert) => ({ context: await contextOf(alert, alert.handoffAt), handoff: alert.handoff })),
  );
  await withTransaction(async (client) => {
    if (!(await lockFault(client, rule))) return;
    // Another filer may have recorded some of these since they were claimed.
    const unfiled = new Set(await unfiledAlerts(client, claimed.map((alert) => alert.id)));
    const alerts = claimed.filter((alert) => unfiled.has(alert.id));
    if (alerts.length === 0) return;
    const ids = alerts.map((alert) => alert.id);
    const filings = prepared.filter(({ context }) => unfiled.has(context.alertId));
    // Everything the monitor wrote for these alerts is newer than their opening.
    const since = Math.min(...alerts.map((alert) => alert.openedAt)) - MARKER_LOOKBACK_MS;
    const said = new Set<string>();
    let number = await refireTarget(client, rule, ids);
    if (number === null) {
      const found = await findIssueWithMarker((marker) => markedAlerts(marker, "issue", rule).length > 0, since);
      if (found.status !== "sent") return logFailedIssue(ids, found);
      if (found.number === null) {
        const opened = await openIssue(rigAlertIssue(filings));
        if (opened.status !== "sent") return logFailedIssue(ids, opened);
        warnIfUnlabelled(opened.number, opened.labelled, ids);
        return recordIssue(client, ids, opened.number);
      }
      warnIfUnlabelled(found.number, found.labelled, ids);
      number = found.number;
      const opened = markedAlerts(found.marker!, "issue", rule);
      for (const id of opened) said.add(id);
      // The alerts it was opened for are on it, whether or not they are in this batch.
      await recordIssue(client, opened, number);
    }

    const comments = await commentMarkers(number, since);
    if (comments.status !== "sent") return logFailedIssue(ids, comments);
    for (const marker of comments.markers) for (const id of markedAlerts(marker, "refire", rule)) said.add(id);
    const joining = filings.filter(({ context }) => !said.has(context.alertId));
    // Alerts a comment already named are recorded as they stand: reopening
    // for them would undo an owner's close for a comment already delivered.
    if (joining.length > 0) {
      const reopened = await reopenIssue(number);
      if (reopened.status !== "sent") return logFailedIssue(ids, reopened);
      const sent = await commentOnIssue(number, refireComment(joining));
      if (sent.status !== "sent") return logFailedIssue(ids, sent);
    }
    await recordIssue(client, ids, number);
  });
}

function warnIfUnlabelled(number: number, labelled: boolean, ids: readonly string[]): void {
  if (labelled) return;
  console.error(
    `[monitor] issue #${number} for alert #${ids.join(", #")} was filed without the rig-alert label; ` +
      "create the label (docs/monitoring.md) or nothing picks the issue up",
  );
}

/**
 * One recovery comment for the alerts of an issue whose every alert has
 * recovered, naming those not yet said so - unless one whose answer was lost
 * already landed.
 */
async function commentRecovery(issue: number, alerts: AlertForMessage[]): Promise<void> {
  const ids = alerts.map((alert) => alert.id);
  const since = Math.min(...alerts.map((alert) => alert.openedAt)) - MARKER_LOOKBACK_MS;
  const found = await commentMarkers(issue, since);
  if (found.status !== "sent") return logFailedIssue(ids, found);
  const said = new Set(found.markers.flatMap((marker) => markedAlerts(marker, "recovery", alerts[0]!.rule)));
  const recovered = alerts.filter((alert) => !said.has(alert.id));
  if (recovered.length > 0) {
    const sent = await commentOnIssue(issue, recoveryComment(recovered));
    if (sent.status !== "sent") return logFailedIssue(ids, sent);
  }
  for (const id of ids) await markDiagnosisPosted(id, "issueRecoveryCommentedAt");
}

function logFailedIssue(ids: readonly string[], result: GitHubResult): void {
  if (result.status === "failed") {
    console.error(`[monitor] GitHub refused or missed the issue update for alert #${ids.join(", #")}: ${result.reason}`);
  }
}

/** `items` in groups sharing `key`, each group in the order its items came. */
function groupBy<T, K>(items: readonly T[], key: (item: T) => K): T[][] {
  const groups = new Map<K, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return [...groups.values()];
}

/** The redacted incident a diagnosis, handoff and issue are written from. */
async function contextOf(alert: AlertForMessage & { subject: string }, until?: string) {
  return incidentContext(
    alert,
    await recentHeartbeats(alert.subject, until),
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() || null,
  );
}

function logFailedPost(id: string, result: Awaited<ReturnType<typeof postDiscord>>): void {
  if (result.status === "failed") {
    console.error(`[monitor] could not post the diagnosis of alert #${id} to Discord: ${result.reason}`);
  }
}

/**
 * Runs an evaluation and then its diagnoses after the current response has
 * been sent (Next's after(), which Vercel keeps the function alive for), so
 * the rig's heartbeat is answered at the speed it always was. Never throws,
 * and a failure is logged and goes nowhere else: the heartbeat is already
 * stored, and the next heartbeat or tick evaluates again. A monitor problem
 * must never turn a heartbeat into a 500 - the rig would read that as the
 * site being down.
 */
export function scheduleMonitor(): void {
  afterResponse("an evaluation", async () => {
    if ((await runMonitor()).evaluated) await runDiagnoses();
  });
}

/**
 * Runs the diagnosis stage after the current response has been sent, for the
 * tick, which awaits its own evaluation but must not wait on a model. Never
 * throws; a failure is logged and the next evaluation's stage retries it.
 */
export function scheduleDiagnoses(): void {
  afterResponse("the diagnoses", runDiagnoses);
}

function afterResponse(what: string, work: () => Promise<unknown>): void {
  try {
    after(async () => {
      try {
        await work();
      } catch (error) {
        console.error(`[monitor] ${what} failed`, (error as Error).message);
      }
    });
  } catch (error) {
    // after() refuses outside a request scope; only routes call this.
    console.error(`[monitor] could not schedule ${what}`, (error as Error).message);
  }
}
