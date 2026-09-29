import { after } from "next/server";
import { withTransaction } from "@/lib/db";
import { diagnose, diagnosisConfig, diagnosisSchema, type DiagnosisConfig } from "./diagnosis";
import { incidentContext } from "./diagnosis/context";
import type { ProviderName } from "./diagnosis/provider";
import { alertUserId, discordConfigured, postDiscord } from "./discord";
import { diagnosisMessage, handoffMessage, handoffText } from "./handoff";
import { alertMessage, recoveryMessage, type AlertForMessage } from "./messages";
import { evaluateRules } from "./rules";
import {
  alertsById,
  applyFindings,
  claimAnnounceRetries,
  claimDiagnoses,
  claimDiagnosisPostRetries,
  claimEvaluation,
  claimRecoveryRetries,
  loadSnapshot,
  markAnnounced,
  markDiagnosisPosted,
  markRecoveryAnnounced,
  pruneHeartbeats,
  recentHeartbeats,
  saveDiagnosis,
  type AlertToDiagnose,
  type DiagnosisState,
} from "./store";

/** Calls per alert: the first, and one retry (plan section 10). */
export const DIAGNOSIS_ATTEMPTS = 2;

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
 * Urgent alerts' diagnoses and handoffs, and the retry of any that Discord
 * refused. Runs after an evaluation, so every alert and recovery has had its
 * turn first and a slow or failing model delays nothing; the claims keep two
 * concurrent runs from diagnosing or posting the same alert. Returns how many
 * diagnoses were made.
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
  const context = incidentContext(
    alert,
    await recentHeartbeats(alert.subject),
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() || null,
  );
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
