import { venueTime } from "./messages";
import { rigState, type Heartbeat } from "./rig-state";
import {
  driverName,
  duration,
  flapScope,
  rigSubject,
  SILENT_AFTER_MS,
  type Finding,
  type MonitorSnapshot,
  type RigSnapshot,
  type Severity,
} from "./rules";

/**
 * The staff Rig health page's tiles, from the same snapshot and the same
 * findings the Discord alerts come from (evaluateRules). A tile's colour is
 * the rules' answer and nothing else: red when a rule finds something urgent
 * on the rig, yellow for a warning. With no finding it is green while the rig
 * is running, and grey when it is not - never seen, closed, or quiet in a way
 * no rule calls a problem (off for the day, or a lone rig inside the venue
 * silence window). Pure, like the rules, so every state is tested from a
 * hand-built snapshot.
 */

export type TileColour = "red" | "yellow" | "green" | "grey";

export type Problem = { severity: Severity; headline: string };

export type RigTile = {
  id: string;
  label: string;
  colour: TileColour;
  /** "online", "agent closed", "silent 4 min", "never seen". */
  status: string;
  /** What the rules found on this rig, worst first. */
  problems: Problem[];
  driver: string | null;
  iracing: string;
  lastLap: string;
  queue: string;
  agent: string;
  footprint: string | null;
  clockSkew: string | null;
  heartbeat: string;
  /** Its heartbeats carry nothing but a version: an agent from before rig-agent/0.4. */
  oldAgent: boolean;
  /** Rule 11: not the build the venue should be running. */
  outdated: boolean;
};

const TOO_OLD = "agent too old to report";

export function rigTiles(
  snapshot: MonitorSnapshot,
  findings: readonly Finding[],
  lastLapAtByRig: ReadonlyMap<string, number>,
): RigTile[] {
  return snapshot.rigs.map((rig) =>
    rigTile(
      snapshot.now,
      rig,
      // A rule may name something finer than the rig (rule 11 a build, rule
      // 14 a lap); flapScope is the rig it is about.
      findings.filter((f) => flapScope(f.subject) === rigSubject(rig.id)),
      lastLapAtByRig.get(rig.id) ?? null,
    ),
  );
}

function rigTile(now: number, rig: RigSnapshot, mine: Finding[], lastLapAt: number | null): RigTile {
  const state = rigState(rig.heartbeats);
  const neverSeen = rig.lastSeenAt === null && state === null;
  const quiet = rig.lastSeenAt === null ? null : now - rig.lastSeenAt;
  const running = !neverSeen && !state?.shuttingDown && quiet !== null && quiet <= SILENT_AFTER_MS;
  const oldAgent = state !== null && isOldAgent(state);

  const urgent = mine.some((f) => f.severity === "urgent");
  const colour: TileColour = urgent
    ? "red"
    : mine.length > 0
      ? "yellow"
      : running
        ? "green"
        : "grey";

  return {
    id: rig.id,
    label: `R${String(rig.number).padStart(2, "0")}`,
    colour,
    status: neverSeen
      ? "never seen"
      : state?.shuttingDown
        ? "agent closed"
        : running
          ? "online"
          : `silent ${duration(quiet!)}`,
    problems: problems(mine),
    driver: rig.seated
      ? `${driverName(rig.seated)} · ${duration(now - rig.seated.startedAt)}`
      : null,
    iracing: iracing(state, oldAgent),
    lastLap: lastLapAt === null ? "no laps today" : `last lap ${venueTime(lastLapAt)}`,
    queue:
      state?.pendingLaps == null
        ? `queue: ${state ? TOO_OLD : "unknown"}`
        : `queue ${state.pendingLaps} · parked ${state.rejectedLaps ?? 0}`,
    agent: state?.agentVersion?.replace(/^rig-agent\//, "agent ") ?? "agent unknown",
    footprint: oldAgent
      ? `CPU and MB: ${TOO_OLD}`
      : state?.agentCpuPercent != null && state.agentMemoryMb != null
        ? `${state.agentCpuPercent.toFixed(1)}% CPU · ${Math.round(state.agentMemoryMb)} MB`
        : null,
    clockSkew: oldAgent
      ? `clock: ${TOO_OLD}`
      : state?.clockSkewMs == null
        ? null
        : `clock ${skew(state.clockSkewMs)}`,
    heartbeat: state === null ? "no heartbeat" : `heartbeat ${duration(now - state.receivedAt)} ago`,
    oldAgent,
    outdated: mine.some((f) => f.rule === "agent_outdated"),
  };
}

/**
 * Findings as lines, urgent first, each headline once: two findings can say
 * the same thing (rule 11 still open for the previous build and new for the
 * current one both say which build to install).
 */
export function problems(findings: readonly Finding[]): Problem[] {
  const lines = new Map<string, Problem>();
  for (const f of [...findings].sort(
    (a, b) => Number(b.severity === "urgent") - Number(a.severity === "urgent"),
  )) {
    if (!lines.has(f.detail.headline)) {
      lines.set(f.detail.headline, { severity: f.severity, headline: f.detail.headline });
    }
  }
  return [...lines.values()];
}

/** A v1 heartbeat: the rules that need its fields cannot fire on this rig. */
function isOldAgent(state: Heartbeat): boolean {
  return state.simConnected === null && state.pendingLaps === null && state.processStartedAt === null;
}

function iracing(state: Heartbeat | null, oldAgent: boolean): string {
  if (state === null) return "iRacing unknown";
  if (oldAgent) return `iRacing: ${TOO_OLD}`;
  // A goodbye says nothing current about the sim.
  if (state.shuttingDown) return "iRacing: agent closed";
  if (state.telemetryFaulted) return "lap reading stopped";
  if (!state.simConnected) return "iRacing not running";
  if (!state.session) return "iRacing idle";
  const { trackName, trackConfig, carName } = state.session;
  return `${[trackName, trackConfig].filter(Boolean).join(" ")} · ${carName}`;
}

/** received_at - sent_at: positive when the rig's clock is behind. */
function skew(ms: number): string {
  if (Math.abs(ms) < 1000) return "in sync";
  return `${duration(Math.abs(ms))} ${ms > 0 ? "behind" : "ahead"}`;
}
