/**
 * Fake rig agent — demos and exercises the ingestion API with zero iRacing.
 *
 * Usage:
 *   npx tsx scripts/fake-rig.ts [options]
 *     --token <rig bearer token>   default: dev-rig-1-secret (seed rig 1)
 *     --base <api base url>        default: http://localhost:3000
 *     --interval <seconds>         default: 20 (real laps take ~90+)
 *     --pace <base lap ms>         default: 138500
 *
 * Sends a heartbeat every 30s and a LAP_COMPLETED every interval, with
 * jittered lap times around the pace, ~15% dirty laps (incidentDelta > 0),
 * and an occasional deliberate duplicate eventId to prove idempotency.
 *
 * Like the real agent, it polls GET /api/agent/assignment and stamps each lap
 * with the assignment that was open when the lap was "driven" - the backend
 * attributes from that stamp, and stores a lap that carries none unattributed
 * and unrankable, so a fake rig that skipped the poll would fill /staff's
 * Unclaimed laps list instead of a leaderboard. Check in before starting it.
 */

import { z } from "zod";
import { heartbeatEvent, type LapCompletedEvent } from "../src/lib/events";

type HeartbeatEvent = z.infer<typeof heartbeatEvent>;
type AgentEvent = HeartbeatEvent | LapCompletedEvent;

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const TOKEN = arg("token", "dev-rig-1-secret");
const BASE = arg("base", "http://localhost:3000").replace(/\/$/, "");
const INTERVAL_MS = Number(arg("interval", "20")) * 1000;
const PACE_MS = Number(arg("pace", "138500"));

const COMBO = {
  trackName: "Spa-Francorchamps",
  trackConfig: "Grand Prix Pits",
  carName: "Porsche 911 GT3 R",
};

const POLL_MS = 10_000;

let lapNumber = 0;
let lastEventId: string | null = null;
/**
 * The rig's open assignment as last polled: a string id, or null when the poll
 * came back saying nobody is checked in. It stays `undefined` until a poll has
 * actually SUCCEEDED, which is the same distinction the real agent draws - and
 * the whole point of this contract. Sending `rigAssignmentId: null` before ever
 * getting an answer would assert "nobody was checked in" on a rig that may well
 * have a driver, and store their laps as unclaimed.
 */
let assignmentId: string | null | undefined;

async function pollAssignment(): Promise<void> {
  try {
    const res = await fetch(`${BASE}/api/agent/assignment`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { assignment: { id: string } | null };
    const next = body.assignment?.id ?? null;
    if (next !== assignmentId) {
      console.log(`[fake-rig] assignment: ${next ?? "nobody checked in"}`);
    }
    assignmentId = next;
  } catch (error) {
    console.error(`[fake-rig] assignment poll failed:`, (error as Error).message);
  }
}

async function post(events: AgentEvent[]): Promise<void> {
  try {
    const res = await fetch(`${BASE}/api/agent/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ events }),
    });
    const body = await res.json().catch(() => ({}));
    console.log(`[fake-rig] ${res.status}`, JSON.stringify(body));
  } catch (error) {
    console.error(`[fake-rig] request failed:`, (error as Error).message);
  }
}

/** Only called once a poll has succeeded, so assignmentId is a real answer. */
function nextLap(assignment: string | null): LapCompletedEvent {
  lapNumber += 1;

  // ~7%: resend the previous event verbatim to prove duplicates are dropped.
  if (lastEventId && Math.random() < 0.07) {
    console.log(`[fake-rig] resending duplicate ${lastEventId}`);
    return {
      type: "LAP_COMPLETED",
      eventId: lastEventId,
      rigAssignmentId: assignment,
      ...COMBO,
      lapNumber: lapNumber - 1,
      lapTimeMs: PACE_MS,
      incidentDelta: 0,
      completedAt: new Date().toISOString(),
    };
  }

  const dirty = Math.random() < 0.15;
  const jitter = Math.round((Math.random() - 0.35) * 2500); // improves over time-ish
  lastEventId = `fake-${TOKEN.slice(-8)}-${Date.now()}-${lapNumber}`;

  return {
    type: "LAP_COMPLETED",
    eventId: lastEventId,
    rigAssignmentId: assignment,
    ...COMBO,
    lapNumber,
    lapTimeMs: Math.max(60_000, PACE_MS + jitter + (dirty ? 4000 : 0)),
    incidentDelta: dirty ? 1 : 0,
    completedAt: new Date().toISOString(),
  };
}

console.log(`[fake-rig] driving ${COMBO.trackName} / ${COMBO.carName}`);
console.log(`[fake-rig] api=${BASE} lap every ${INTERVAL_MS / 1000}s — Ctrl+C to stop`);

void pollAssignment();
setInterval(() => void pollAssignment(), POLL_MS);
void post([{ type: "RIG_HEARTBEAT", agentVersion: "fake-rig/0.2" }]);
setInterval(() => void post([{ type: "RIG_HEARTBEAT", agentVersion: "fake-rig/0.2" }]), 30_000);
setInterval(() => {
  // The real agent queues these laps unresolved and stamps them once a poll
  // gets through; a simulator with no outbox just waits for the answer rather
  // than inventing one.
  if (assignmentId === undefined) {
    console.log("[fake-rig] no assignment poll has succeeded yet - skipping this lap");
    return;
  }
  void post([nextLap(assignmentId)]);
}, INTERVAL_MS);
