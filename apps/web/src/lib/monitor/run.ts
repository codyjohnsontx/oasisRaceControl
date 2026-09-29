import { after } from "next/server";
import { withTransaction } from "@/lib/db";
import { alertUserId, discordConfigured, postDiscord } from "./discord";
import { alertMessage, recoveryMessage, type AlertForMessage } from "./messages";
import { evaluateRules } from "./rules";
import {
  alertsById,
  applyFindings,
  claimAnnounceRetries,
  claimEvaluation,
  claimRecoveryRetries,
  loadSnapshot,
  markAnnounced,
  markRecoveryAnnounced,
  pruneHeartbeats,
} from "./store";

/**
 * One monitor evaluation, end to end: claim it, read the snapshot, run the
 * rules, apply the transitions, post what this evaluation won, retry what an
 * earlier one could not deliver, and prune old heartbeats when that is due.
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
