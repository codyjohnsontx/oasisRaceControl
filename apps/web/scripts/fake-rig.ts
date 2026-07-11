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
 */

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

let lapNumber = 0;
let lastEventId: string | null = null;

async function post(events: object[]): Promise<void> {
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

function nextLap(): object {
  lapNumber += 1;

  // ~7%: resend the previous event verbatim to prove duplicates are dropped.
  if (lastEventId && Math.random() < 0.07) {
    console.log(`[fake-rig] resending duplicate ${lastEventId}`);
    return {
      type: "LAP_COMPLETED",
      eventId: lastEventId,
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
    ...COMBO,
    lapNumber,
    lapTimeMs: Math.max(60_000, PACE_MS + jitter + (dirty ? 4000 : 0)),
    incidentDelta: dirty ? 1 : 0,
    completedAt: new Date().toISOString(),
  };
}

console.log(`[fake-rig] driving ${COMBO.trackName} / ${COMBO.carName}`);
console.log(`[fake-rig] api=${BASE} lap every ${INTERVAL_MS / 1000}s — Ctrl+C to stop`);

void post([{ type: "RIG_HEARTBEAT", agentVersion: "fake-rig/0.1" }]);
setInterval(() => void post([{ type: "RIG_HEARTBEAT", agentVersion: "fake-rig/0.1" }]), 30_000);
setInterval(() => void post([nextLap()]), INTERVAL_MS);
