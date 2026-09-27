/**
 * Manual lap entry for an event where iRacing lap detection is not wired up.
 * Reads the rig's open assignment (who is checked in on that rig right now)
 * and posts ONE lap for it, exactly as the rig agent would.
 *
 *   npx tsx scripts/manual-lap.ts --token <rig token> --ms 152340 \
 *     [--base https://oasis-race-control.vercel.app] \
 *     [--track "Circuit of the Americas" --config "Grand Prix" --car "FIA F4"] \
 *     [--incidents 0]
 *
 * Time can also be given as m:ss.mmm with --time 2:32.340.
 * Refuses when nobody is checked in on the rig: a lap with no driver would be
 * stored unclaimed and never rank.
 */
import { randomUUID } from "node:crypto";

const arg = (name: string, fallback = ""): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};

const BASE = arg("base", "http://localhost:3000").replace(/\/$/, "");
const TOKEN = arg("token");
const TRACK = arg("track", "Circuit of the Americas");
const CONFIG = arg("config", "Grand Prix");
const CAR = arg("car", "FIA F4");
const INCIDENTS = Number(arg("incidents", "0"));

function parseTime(): number {
  if (arg("ms")) return Number(arg("ms"));
  const t = arg("time");
  const m = t.match(/^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (!m) throw new Error("give --ms <milliseconds> or --time m:ss.mmm");
  return Number(m[1]) * 60_000 + Number(m[2]) * 1000 + Number((m[3] ?? "0").padEnd(3, "0"));
}

async function main() {
  if (!TOKEN) throw new Error("--token <rig token> is required");
  const lapTimeMs = parseTime();
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

  const poll = await fetch(`${BASE}/api/agent/assignment`, { headers });
  if (!poll.ok) throw new Error(`assignment poll failed: HTTP ${poll.status} (wrong token or base?)`);
  const { assignment } = (await poll.json()) as {
    assignment: { id: string; driver: { displayName: string } } | null;
  };
  if (!assignment) throw new Error("nobody is checked in on this rig - check the driver in first");

  const event = {
    type: "LAP_COMPLETED",
    eventId: `manual-${randomUUID()}`,
    rigAssignmentId: assignment.id,
    trackName: TRACK,
    trackConfig: CONFIG || null,
    carName: CAR,
    lapTimeMs,
    incidentDelta: INCIDENTS,
    completedAt: new Date().toISOString(),
  };
  const res = await fetch(`${BASE}/api/agent/events`, {
    method: "POST",
    headers,
    body: JSON.stringify({ events: [event] }),
  });
  const body = await res.text();
  console.log(`${res.status} ${assignment.driver.displayName} ${TRACK} / ${CAR} ${lapTimeMs} ms -> ${body}`);
  if (!res.ok) process.exit(1);
}

main().catch((e) => {
  console.error(`[manual-lap] ${(e as Error).message}`);
  process.exit(1);
});
