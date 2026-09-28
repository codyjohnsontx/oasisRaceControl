/**
 * Fallback for a rig whose agent cannot read iRacing: posts ONE lap by hand
 * for whoever is checked in on that rig right now, exactly as the rig agent
 * would.
 *
 *   npx tsx scripts/manual-lap.ts --token <rig token> \
 *     --base https://oasis-race-control.vercel.app \
 *     --time 2:32.340 [--incidents 0]
 *
 * Time can also be given in milliseconds with --ms 152340.
 * The track, layout and car are never typed here: the lap carries today's
 * featured combo exactly as the app at --base holds it, so it is judged
 * against the same strings the wall shows. Refuses when no featured combo is
 * set, and when nobody is checked in on the rig: a lap with no driver would be
 * stored unclaimed and never rank. Exits non-zero unless the backend reports
 * the lap stored for that driver (manual-lap-outcome.ts) - HTTP 200 alone is
 * not that.
 */
import { randomUUID } from "node:crypto";
import { manualLapOutcome } from "./manual-lap-outcome";

const arg = (name: string, fallback = ""): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};

const BASE = arg("base").replace(/\/$/, "");
const TOKEN = arg("token");
const INCIDENTS = Number(arg("incidents", "0"));

type FeaturedCombo = { track_name: string; track_config: string | null; car_name: string };

function parseTime(): number {
  if (arg("ms")) return Number(arg("ms"));
  const t = arg("time");
  const m = t.match(/^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (!m) throw new Error("give --ms <milliseconds> or --time m:ss.mmm");
  return Number(m[1]) * 60_000 + Number(m[2]) * 1000 + Number((m[3] ?? "0").padEnd(3, "0"));
}

async function featuredCombo(): Promise<FeaturedCombo> {
  const res = await fetch(`${BASE}/api/leaderboard/tonight`);
  if (!res.ok) throw new Error(`reading the featured combo failed: HTTP ${res.status} from ${BASE}`);
  const { combo } = (await res.json()) as { combo: FeaturedCombo | null };
  if (!combo) {
    throw new Error(
      `no featured combo is set for today on ${BASE} - set it first (see the rig-agent README, Setting the featured combo)`,
    );
  }
  return combo;
}

async function main() {
  if (!TOKEN) throw new Error("--token <rig token> is required");
  if (!BASE) throw new Error("--base <app url> is required, e.g. --base https://oasis-race-control.vercel.app");
  const lapTimeMs = parseTime();
  const combo = await featuredCombo();
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
    trackName: combo.track_name,
    trackConfig: combo.track_config,
    carName: combo.car_name,
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
  console.log(
    `${res.status} ${assignment.driver.displayName} ${combo.track_name} / ${combo.car_name} ${lapTimeMs} ms -> ${body}`,
  );
  if (!res.ok) process.exit(1);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Reported below as an answer with no result.
  }
  const outcome = manualLapOutcome(parsed, assignment.driver.displayName);
  if (!outcome.ok) throw new Error(outcome.message);
  console.log(`[manual-lap] ${outcome.message}`);
}

main().catch((e) => {
  console.error(`[manual-lap] ${(e as Error).message}`);
  process.exit(1);
});
