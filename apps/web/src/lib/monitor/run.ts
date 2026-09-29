import { after } from "next/server";
import { diagnose, diagnosisConfig, diagnosisSchema, type DiagnosisConfig } from "./diagnosis";
import { incidentContext } from "./diagnosis/context";
import type { ProviderName } from "./diagnosis/provider";
import { alertUserId, discordConfigured, postDiscord } from "./discord";
import { commentOnIssue, githubConfigured, openIssue, type GitHubResult } from "./github";
import {
  diagnosisMessage,
  handoffMessage,
  handoffText,
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
  markAnnounced,
  markDiagnosisPosted,
  markRecoveryAnnounced,
  pruneHeartbeats,
  recentHeartbeats,
  recordIssue,
  saveDiagnosis,
  type AlertToDiagnose,
  type AlertToFile,
  type DiagnosisState,
} from "./store";

/** Calls per alert: the first, and one retry (plan section 10). */
export const DIAGNOSIS_ATTEMPTS = 2;

/** Rules where software is a plausible cause: their urgent alerts always get an issue. */
const SOFTWARE_RULES = Object.entries(RULES)
  .filter(([, rule]) => rule.software)
  .map(([key]) => key);

/**
 * One monitor evaluation, end to end: claim it, read the snapshot, run the
 * rules, apply the transitions, post what this evaluation won, retry what an
 * earlier one could not deliver, and prune old heartbeats when that is due.
 *
 * Nothing runs it on a timer inside Vercel (Hobby cron is once a day). It
 * runs after every rig heartbeat's response has gone (scheduleMonitor) and on
 * every GET /api/monitor/tick from the external one-minute clock, and the
 * claim throttles all of them to one evaluation at a time.
 */
export type MonitorRun =
  | { evaluated: false }
  | { evaluated: true; findings: number; announced: number; recovered: number; diagnosed: number };

export async function runMonitor(): Promise<MonitorRun> {
  const claim = await claimEvaluation();
  if (!claim) return { evaluated: false };

  const snapshot = await loadSnapshot(claim.now);
  const findings = evaluateRules(snapshot);
  const won = await applyFindings(findings, snapshot.openAlerts);

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

  // Urgent alerts' diagnoses and handoffs come after every alert and recovery
  // above has had its turn, so a slow or failing model delays nothing.
  let diagnosed = 0;
  const config = diagnosisConfig();
  if (config && discordConfigured()) {
    for (const alert of await claimDiagnoses()) {
      if (await diagnoseAlert(alert, config)) diagnosed++;
    }
  }
  if (discordConfigured()) {
    for (const row of await claimDiagnosisPostRetries()) {
      await postDiagnosis(row.alert, row.diagnosis, row.handoff);
    }
  }

  // The rig-alert issue comes last: it carries the handoff written above, and
  // a slow GitHub delays no Discord post. Without a token nothing is claimed
  // and the Discord handoff is the whole story.
  if (githubConfigured()) {
    for (const alert of await claimIssues(SOFTWARE_RULES)) await fileIssue(alert);
    for (const alert of await claimIssueRecoveries()) {
      const sent = await commentOnIssue(alert.issue, recoveryComment(alert));
      if (sent.status === "sent") await markDiagnosisPosted(alert.id, "issueRecoveryCommentedAt");
      else logFailedIssue(alert.id, sent);
    }
  }

  const pruned = await pruneHeartbeats();
  if (pruned !== null) console.log(`[monitor] pruned ${pruned} heartbeat(s) past retention`);

  return { evaluated: true, findings: findings.length, announced, recovered, diagnosed };
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
 * Opens the alert's rig-alert issue, or - when an earlier alert on the same
 * rule and rig opened one within a day - comments on that one instead, so a
 * flapping rig makes one issue. A failure is retried by a later evaluation.
 */
async function fileIssue(alert: AlertToFile): Promise<void> {
  const context = await contextOf(alert);
  if (alert.refireOf !== null) {
    const sent = await commentOnIssue(alert.refireOf, refireComment(context, alert.handoff));
    if (sent.status !== "sent") return logFailedIssue(alert.id, sent);
    return recordIssue(alert.id, alert.refireOf);
  }
  const opened = await openIssue(rigAlertIssue(context, alert.handoff));
  if (opened.status !== "sent") return logFailedIssue(alert.id, opened);
  if (!opened.labelled) {
    console.error(
      `[monitor] issue #${opened.number} for alert #${alert.id} was filed without the rig-alert label; ` +
        "create the label (docs/monitoring.md) or nothing picks the issue up",
    );
  }
  await recordIssue(alert.id, opened.number);
}

function logFailedIssue(id: string, result: GitHubResult): void {
  if (result.status === "failed") {
    console.error(`[monitor] GitHub refused or missed the issue update for alert #${id}: ${result.reason}`);
  }
}

/** The redacted incident a diagnosis, handoff and issue are written from. */
async function contextOf(alert: AlertForMessage & { subject: string }) {
  return incidentContext(
    alert,
    await recentHeartbeats(alert.subject),
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() || null,
  );
}

function logFailedPost(id: string, result: Awaited<ReturnType<typeof postDiscord>>): void {
  if (result.status === "failed") {
    console.error(`[monitor] could not post the diagnosis of alert #${id} to Discord: ${result.reason}`);
  }
}

/**
 * Runs an evaluation after the current response has been sent (Next's
 * after(), which Vercel keeps the function alive for), so the rig's heartbeat
 * is answered at the speed it always was. Never throws, and a failure is
 * logged and goes nowhere else: the heartbeat is already stored, and the
 * next heartbeat or tick evaluates again. A monitor problem must never turn a
 * heartbeat into a 500 - the rig would read that as the site being down.
 */
export function scheduleMonitor(): void {
  try {
    after(async () => {
      try {
        await runMonitor();
      } catch (error) {
        console.error("[monitor] evaluation failed", (error as Error).message);
      }
    });
  } catch (error) {
    // after() refuses outside a request scope; nothing else calls this.
    console.error("[monitor] could not schedule an evaluation", (error as Error).message);
  }
}
