/**
 * Fake rig agent — demos and exercises the ingestion API with zero iRacing.
 *
 * Usage:
 *   npx tsx scripts/fake-rig.ts [options]
 *     --token <rig bearer token>   default: dev-rig-1-secret (seed rig 1)
 *     --base <api base url>        default: http://localhost:3000
 *     --interval <seconds>         default: 20 (real laps take ~90+)
 *     --pace <base lap ms>         default: 138500
 *     --metrics <path>             append one JSON line per request (off by default)
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
 *
 * `--metrics` is what makes this script usable as a load generator as well as a
 * demo: it writes a JSONL record of every request - latency, HTTP status, and
 * the per-event verdict the backend returned - plus a line naming each lap
 * BEFORE it is sent, which is what lets scripts/soak.ts tell a lap it cannot
 * account for from a lap the backend invented (docs/soak-20-rigs.md). Nothing
 * else changes when it is set, so the soak measures the same simulator the
 * demos run - the shutdown drain at the foot of this file is unconditional for
 * the same reason.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
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
const METRICS_PATH = arg("metrics", "");

/** One line per request plus one per lap about to be sent, or nothing at all
 *  when --metrics is not given. Appends are synchronous and each process owns
 *  its own file, so the lines never interleave and a stop loses nothing the
 *  drain below can wait for. Nothing here derives from the bearer token - not
 *  a field, and not the event ids, which is why RIG_TAG below is random rather
 *  than a slice of the token: this file is written wherever the operator points
 *  it, and the reader identifies a rig by its own file.
 *
 *  A line that cannot be written ends this worker. The file is the only record
 *  that a lap was ever announced, so carrying on past a failed append (a full
 *  disk, a --metrics path that stopped being writable) would leave laps in the
 *  database that no rig recorded sending - which the reader can only read as
 *  the backend inventing them. Exiting non-zero makes the soak refuse the run
 *  instead, which is the honest answer. Demos are untouched: no --metrics, no
 *  append. */
function record(entry: Record<string, unknown>): void {
  if (!METRICS_PATH) return;
  try {
    appendFileSync(
      METRICS_PATH,
      `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`,
    );
  } catch (error) {
    console.error(`[fake-rig] metrics write failed:`, (error as Error).message);
    process.exit(1);
  }
}

const COMBO = {
  trackName: "Spa-Francorchamps",
  trackConfig: "Grand Prix Pits",
  carName: "Porsche 911 GT3 R",
};

const POLL_MS = 10_000;
/** How long a drain waits for the request in flight. Shorter than the soak's
 *  five-second SIGKILL escalation, so a hung request is abandoned rather than
 *  the worker being killed with the whole shutdown still pending. The lap it
 *  was sending is not lost when that happens - its `attempt` line is already on
 *  disk, and the reader reports it as one it cannot account for. */
const DRAIN_DEADLINE_MS = 3_000;

let inFlight = 0;
let draining = false;

/** Nothing left to record: leave immediately rather than idling out the
 *  deadline. Called from every request's `finally`, after its line is on disk. */
function exitWhenDrained(): void {
  if (draining && inFlight === 0) process.exit(0);
}

/** What makes this process's event ids unique among the rigs sharing a
 *  database. Random, and deliberately not a slice of the token: event ids reach
 *  the metrics file and `laps.event_id`, and a credential must not be
 *  reconstructable from either. */
const RIG_TAG = randomUUID().slice(0, 8);

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
  const startedAt = Date.now();
  inFlight += 1;
  try {
    const res = await fetch(`${BASE}/api/agent/assignment`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = res.ok
      ? ((await res.json().catch(() => null)) as {
          assignment: { id: string } | null;
        } | null)
      : null;
    const unreadable = res.ok && body === null;
    // Recorded before the status is judged, so a rejected poll is counted as
    // the HTTP answer it was and not as a rig that could not reach the stack.
    // A 200 whose body would not parse is no answer at all, so it is recorded
    // as the failure it is rather than as an assignment.
    record({
      kind: "poll",
      ms: Date.now() - startedAt,
      status: res.status,
      ...(unreadable ? { error: "unreadable assignment body" } : {}),
    });
    if (!res.ok) {
      console.error(`[fake-rig] assignment poll failed: HTTP ${res.status}`);
      return;
    }
    if (!body) {
      console.error(`[fake-rig] assignment poll returned an unreadable body`);
      return;
    }
    const next = body.assignment?.id ?? null;
    if (next !== assignmentId) {
      console.log(`[fake-rig] assignment: ${next ?? "nobody checked in"}`);
    }
    assignmentId = next;
  } catch (error) {
    record({ kind: "poll", ms: Date.now() - startedAt, error: (error as Error).message });
    console.error(`[fake-rig] assignment poll failed:`, (error as Error).message);
  } finally {
    inFlight -= 1;
    exitWhenDrained();
  }
}

async function post(events: AgentEvent[]): Promise<void> {
  const kind = events[0]?.type === "LAP_COMPLETED" ? "lap" : "heartbeat";
  const sent = events.flatMap((e) => (e.type === "LAP_COMPLETED" ? [e.eventId] : []));
  // Named before it leaves, because the request that follows can outlive this
  // process: a lap the backend has already stored, whose outcome line never
  // got written, would otherwise be a lap in the database that no rig ever
  // mentioned. The reader can only call that indeterminate if it knows the rig
  // was in the middle of sending it.
  if (sent.length > 0) record({ kind: "attempt", sent });
  const startedAt = Date.now();
  inFlight += 1;
  try {
    const res = await fetch(`${BASE}/api/agent/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ events }),
    });
    // Same shape as the assignment poll above, and for the same reason: a 200
    // whose body will not parse is not an answer. Swallowing it into `{}` here
    // recorded a clean 200 with no results, so the events endpoint was the one
    // place `unusableAnswers` could never see - the poll was fixed and this was
    // left, a half-applied fix that reads as a whole one.
    const body = (await res.json().catch(() => null)) as {
      results?: Array<{ eventId?: string; status: string }>;
    } | null;
    // `sent` and `results` are both recorded: a lap the backend never ruled on
    // is the loss a soak exists to catch, and only the difference shows it.
    record({
      kind,
      ms: Date.now() - startedAt,
      status: res.status,
      sent,
      results: body?.results ?? [],
      ...(body === null ? { error: "unreadable events body" } : {}),
    });
    console.log(`[fake-rig] ${res.status}`, JSON.stringify(body));
  } catch (error) {
    record({ kind, ms: Date.now() - startedAt, sent, error: (error as Error).message });
    console.error(`[fake-rig] request failed:`, (error as Error).message);
  } finally {
    inFlight -= 1;
    exitWhenDrained();
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
  lastEventId = `fake-${RIG_TAG}-${Date.now()}-${lapNumber}`;

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
void post([{ type: "RIG_HEARTBEAT", agentVersion: "fake-rig/0.2" }]);

const timers = [
  setInterval(() => void pollAssignment(), POLL_MS),
  setInterval(
    () => void post([{ type: "RIG_HEARTBEAT", agentVersion: "fake-rig/0.2" }]),
    30_000,
  ),
  setInterval(() => {
    // The real agent queues these laps unresolved and stamps them once a poll
    // gets through; a simulator with no outbox just waits for the answer rather
    // than inventing one.
    if (assignmentId === undefined) {
      console.log("[fake-rig] no assignment poll has succeeded yet - skipping this lap");
      return;
    }
    void post([nextLap(assignmentId)]);
  }, INTERVAL_MS),
];

/**
 * Dying mid-post loses the outcome line for a lap the backend has ALREADY
 * stored. So a stop stops new requests and lets the one in flight finish and
 * write its line. Bounded both ways: a hung request is abandoned at
 * DRAIN_DEADLINE_MS, and a second signal finds no listener and terminates
 * outright - and what the drain cannot wait for, the `attempt` line above
 * keeps honest rather than silent.
 */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    draining = true;
    for (const timer of timers) clearInterval(timer);
    setTimeout(() => process.exit(0), DRAIN_DEADLINE_MS).unref();
    exitWhenDrained();
  });
}
