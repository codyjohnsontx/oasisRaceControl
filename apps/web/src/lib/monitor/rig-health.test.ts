import { describe, expect, it } from "vitest";
import { CURRENT_AGENT_VERSION } from "./agent-version";
import type { Heartbeat } from "./rig-state";
import { rigTiles, type TileColour } from "./rig-health";
import {
  evaluateRules,
  flapScope,
  rigSubject,
  SILENT_AFTER_MS,
  type MonitorSnapshot,
  type RigSnapshot,
} from "./rules";

/**
 * The Rig health page's tiles. What must hold: a tile's colour is the rules'
 * answer for the same snapshot - red for an urgent finding on that rig,
 * yellow for a warning - and with no finding, green while the rig runs and
 * grey when it does not. An agent too old to send the v2 fields says so
 * rather than showing blanks as if they were healthy.
 */

const NOW = Date.parse("2026-10-04T21:00:00Z");
const S = 1000;
const MIN = 60 * S;
const STARTED = NOW - 3 * 60 * MIN;

let nextId = 0;

function hb(ago: number, overrides: Partial<Heartbeat> = {}): Heartbeat {
  const receivedAt = NOW - ago;
  return {
    id: String(++nextId),
    receivedAt,
    sentAt: receivedAt,
    clockSkewMs: 0,
    processStartedAt: STARTED,
    sequence: Math.round((receivedAt - STARTED) / MIN),
    agentVersion: CURRENT_AGENT_VERSION,
    telemetryMode: "iracing",
    simConnected: true,
    telemetryFaulted: false,
    session: { trackName: "Circuit of the Americas", trackConfig: "Grand Prix", carName: "FIA F4" },
    pendingLaps: 0,
    oldestPendingAgeS: null,
    rejectedLaps: 0,
    checkout: "none",
    signInFailures: 0,
    signInFailureKinds: [],
    signInFailureSeqs: null,
    missingVariables: [],
    agentCpuPercent: 0.3,
    agentMemoryMb: 42,
    shuttingDown: false,
    ...overrides,
  };
}

/** A v1 heartbeat: a version and nothing else (rig-agent/0.3-event). */
function v1(ago: number): Heartbeat {
  return {
    ...hb(ago),
    sentAt: null,
    clockSkewMs: null,
    processStartedAt: null,
    sequence: null,
    agentVersion: "rig-agent/0.3-event",
    telemetryMode: null,
    simConnected: null,
    telemetryFaulted: null,
    session: null,
    pendingLaps: null,
    rejectedLaps: null,
    checkout: null,
    signInFailures: null,
    agentCpuPercent: null,
    agentMemoryMb: null,
  };
}

/** Each unbroken run of heartbeats, as loadSnapshot builds RigSnapshot.heard. */
function runsOf(heartbeats: Heartbeat[]): RigSnapshot["heard"] {
  const runs: RigSnapshot["heard"] = [];
  for (const { receivedAt } of heartbeats) {
    const last = runs.at(-1);
    if (last && receivedAt - last.to <= SILENT_AFTER_MS) last.to = receivedAt;
    else runs.push({ from: receivedAt, to: receivedAt });
  }
  return runs;
}

function minutely(from: number, shape: (ago: number) => Heartbeat = (ago) => hb(ago)): Heartbeat[] {
  const rows: Heartbeat[] = [];
  for (let ago = from; ago >= 0; ago -= MIN) rows.push(shape(ago));
  return rows;
}

function rig(number: number, heartbeats: Heartbeat[], overrides: Partial<RigSnapshot> = {}): RigSnapshot {
  return {
    id: `rig-${number}`,
    number,
    name: `Rig ${String(number).padStart(2, "0")}`,
    lastSeenAt: heartbeats.at(-1)?.receivedAt ?? null,
    seated: null,
    heartbeats,
    heard: runsOf(heartbeats),
    ...overrides,
  };
}

const SEATED = { driverName: "Matt G", driverStatus: "active", startedAt: NOW - 18 * MIN };

const FIXTURES: Record<string, RigSnapshot> = {
  green: rig(1, minutely(10 * MIN), { seated: SEATED }),
  // Rule 18, a warning: the agent holding 200 MB.
  yellow: rig(2, minutely(10 * MIN, (ago) => hb(ago, { agentMemoryMb: 200 }))),
  // Rule 15, urgent: lap reading stopped.
  red: rig(3, minutely(10 * MIN, (ago) => hb(ago, { telemetryFaulted: true }))),
  neverSeen: rig(4, []),
  closed: rig(5, [...minutely(10 * MIN).slice(0, -1), hb(30 * S, { shuttingDown: true })]),
  oldAgent: rig(6, minutely(10 * MIN, v1)),
};

function snapshot(rigs: RigSnapshot[]): MonitorSnapshot {
  return {
    now: NOW,
    venueDayStart: Date.parse("2026-10-04T05:00:00Z"),
    rigs,
    featuredCombo: { trackName: "Circuit of the Americas", trackConfig: "Grand Prix", carName: "FIA F4" },
    longStintMinutes: 120,
    laps: [],
    lapBests: [],
    moves: [],
    override: null,
    eventModeSince: null,
    boards: [],
    openAlerts: [],
  };
}

function tiles(rigs: RigSnapshot[], lastLaps = new Map<string, number>()) {
  const snap = snapshot(rigs);
  return rigTiles(snap, evaluateRules(snap), lastLaps);
}

describe("rig tile colour", () => {
  const all = Object.values(FIXTURES);
  const computed = tiles(all);
  const byName = Object.fromEntries(Object.keys(FIXTURES).map((name, i) => [name, computed[i]!]));

  it.each([
    ["green", "green", "online"],
    ["yellow", "yellow", "online"],
    ["red", "red", "online"],
    ["neverSeen", "grey", "never seen"],
    ["closed", "grey", "agent closed"],
    // Rule 11, a warning: not the build the venue should be running.
    ["oldAgent", "yellow", "online"],
  ] as const)("%s reads %s, %s", (name, colour, status) => {
    expect(byName[name]!.colour).toBe(colour satisfies TileColour);
    expect(byName[name]!.status).toBe(status);
  });

  it("is the rule module's answer for the same snapshot, rig by rig", () => {
    const snap = snapshot(all);
    const findings = evaluateRules(snap);
    for (const tile of rigTiles(snap, findings, new Map())) {
      const mine = findings.filter((f) => flapScope(f.subject) === rigSubject(tile.id));
      const expected = mine.some((f) => f.severity === "urgent")
        ? "red"
        : mine.length > 0
          ? "yellow"
          : null;
      if (expected) expect(tile.colour).toBe(expected);
      else expect(["green", "grey"]).toContain(tile.colour);
      expect(tile.problems.map((p) => p.headline).sort()).toEqual(
        mine.map((f) => f.detail.headline).sort(),
      );
    }
  });

  it("turns grey, not green, for a rig quiet past the silence line that no rule reports", () => {
    // Off for the day: last heard 13 hours ago, beyond the rules' look-back.
    const off = rig(7, [hb(13 * 60 * MIN)]);
    const [tile] = tiles([off]);
    expect(tile!.colour).toBe("grey");
    expect(tile!.status).toBe("silent 13 h");
  });

  it("turns red for a silent rig with a driver seated, as rule 1 does", () => {
    const silent = rig(8, minutely(10 * MIN).filter((h) => h.receivedAt <= NOW - 4 * MIN), {
      seated: SEATED,
    });
    const [tile] = tiles([silent]);
    expect(tile!.colour).toBe("red");
    expect(tile!.status).toBe("silent 4 min");
  });
});

describe("rig tile fields", () => {
  it("shows the driver, the session, the last lap, the queue and the agent", () => {
    const [tile] = tiles([FIXTURES.green!], new Map([["rig-1", NOW - 3 * MIN]]));
    expect(tile).toMatchObject({
      label: "R01",
      driver: "Matt G · 18 min",
      iracing: "Circuit of the Americas Grand Prix · FIA F4",
      lastLap: "last lap 3:57 PM",
      queue: "queue 0 · parked 0",
      agent: CURRENT_AGENT_VERSION.replace(/^rig-agent\//, "agent "),
      footprint: "0.3% CPU · 42 MB",
      clockSkew: "clock in sync",
      heartbeat: "heartbeat 0 s ago",
      oldAgent: false,
      outdated: false,
      problems: [],
    });
  });

  it("says an old agent is too old to report instead of showing its blanks as healthy", () => {
    const [tile] = tiles([FIXTURES.oldAgent!]);
    expect(tile).toMatchObject({
      oldAgent: true,
      outdated: true,
      agent: "agent 0.3-event",
      iracing: "iRacing: agent too old to report",
      queue: "queue: agent too old to report",
      footprint: null,
      clockSkew: null,
    });
  });

  it("badges an outdated build, whose finding is about the rig and the build", () => {
    const [tile] = tiles([
      rig(1, minutely(5 * MIN, (ago) => hb(ago, { agentVersion: "rig-agent/0.4-monitor" }))),
    ]);
    expect(tile).toMatchObject({ colour: "yellow", outdated: true, oldAgent: false });
    expect(tile!.problems).toHaveLength(1);
  });

  it("never names a driver whose name is under review", () => {
    const [tile] = tiles([
      rig(1, minutely(5 * MIN), { seated: { ...SEATED, driverStatus: "flagged" } }),
    ]);
    expect(tile!.driver).toBe("a driver (name under review) · 18 min");
  });

  it("lists urgent problems before warnings", () => {
    const both = rig(9, minutely(10 * MIN, (ago) => hb(ago, { telemetryFaulted: true, agentMemoryMb: 200 })));
    const [tile] = tiles([both]);
    expect(tile!.problems.map((p) => p.severity)).toEqual(["urgent", "warning"]);
  });
});
