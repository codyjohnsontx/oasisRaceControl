import { describe, expect, it } from "vitest";
import { CURRENT_AGENT_VERSION } from "./agent-version";
import type { BoardSnapshot } from "./event-mode";
import { flowModel, RULE_PLACE, type FlowModel } from "./flow";
import { shownFindings } from "./rig-health";
import type { Heartbeat } from "./rig-state";
import {
  evaluateRules,
  RULES,
  SILENT_AFTER_MS,
  type LapSnapshot,
  type MonitorSnapshot,
  type RigSnapshot,
} from "./rules";

/**
 * The data-flow view's model. What must hold: every rule has a place in the
 * picture; a part is coloured by what the rules found for the same snapshot
 * and nothing else; the broken edge is the first red one walking downstream
 * (else the first yellow), and only a red one fades what lies past it; and
 * traffic is placed by age and carries each lap's status.
 *
 * Each case builds a snapshot and runs the real evaluateRules on it, so a
 * fixture that stops triggering its rule fails here rather than passing on a
 * hand-written finding.
 */

const NOW = Date.parse("2026-10-04T21:00:00Z"); // 4 PM at the venue
const S = 1000;
const MIN = 60 * S;
const STARTED = NOW - 3 * 60 * MIN;
const DAY_START = Date.parse("2026-10-04T05:00:00Z");

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

/** A heartbeat a minute from `from` ago up to `to` ago. */
function minutely(from: number, to = 0, overrides: Partial<Heartbeat> = {}): Heartbeat[] {
  const rows: Heartbeat[] = [];
  for (let ago = from; ago >= to; ago -= MIN) rows.push(hb(ago, overrides));
  return rows;
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

function rig(number: number, heartbeats: Heartbeat[], overrides: Partial<RigSnapshot> = {}): RigSnapshot {
  return {
    id: `rig-${number}`,
    number,
    name: `Rig ${String(number).padStart(2, "0")}`,
    lastSeenAt: heartbeats.at(-1)?.receivedAt ?? null,
    seated: { driverName: "Matt G", driverStatus: "active", startedAt: NOW - 40 * MIN },
    heartbeats,
    heard: runsOf(heartbeats),
    ...overrides,
  };
}

function board(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    id: "board-1",
    mode: "event",
    host: null,
    firstSeenAt: NOW - 2 * 60 * MIN,
    lastSeenAt: NOW - 20 * S,
    visible: true,
    feedOk: true,
    feedFailures: 0,
    closedAt: null,
    ...overrides,
  };
}

const COMBO = { trackName: "Circuit of the Americas", trackConfig: "Grand Prix", carName: "FIA F4" };

function snapshot(rigs: RigSnapshot[], overrides: Partial<MonitorSnapshot> = {}): MonitorSnapshot {
  return {
    now: NOW,
    venueDayStart: DAY_START,
    rigs,
    featuredCombo: COMBO,
    longStintMinutes: 120,
    laps: [],
    lapBests: [],
    moves: [],
    override: null,
    eventModeSince: NOW - 2 * 60 * MIN,
    boards: [board()],
    openAlerts: [],
    ...overrides,
  };
}

function model(snap: MonitorSnapshot, lastEvaluatedAt: number | null = NOW - 20 * S): FlowModel {
  return flowModel(snap, evaluateRules(snap), lastEvaluatedAt);
}

/** A lap the site stored `ago` ago. */
function lap(id: string, rigId: string, ago: number, lapTimeMs: number, kind: "accepted" | "invalid" | "unattributed"): LapSnapshot {
  return {
    id,
    rigId,
    receivedAt: NOW - ago,
    driver: kind === "unattributed" ? null : { id: "d1", name: "Matt G", status: "active" },
    combo: COMBO,
    lapTimeMs,
    valid: kind === "accepted",
    invalidReason: kind === "accepted" ? null : kind === "unattributed" ? "UNATTRIBUTED" : "OFF_TRACK",
    unattributedCause: kind === "unattributed" ? "nobody_checked_in" : null,
  };
}

/** A lane or the shared half as one line per part: "iracing green", "e2 red dim". */
function states(m: FlowModel, lane = 0): string[] {
  const l = m.lanes[lane]!;
  const show = (name: string, p: { state: string; dimmed: boolean }) =>
    `${name} ${p.state}${p.dimmed ? " dim" : ""}`;
  return [
    show("iracing", l.nodes.iracing),
    show("e1", l.edges[0]),
    show("agent", l.nodes.agent),
    show("e2", l.edges[1]),
    show("network", l.nodes.network),
    show("e3", l.edges[2]),
    show("server", m.shared.nodes.server),
    show("e4", m.shared.edges[0]),
    show("database", m.shared.nodes.database),
    show("e5", m.shared.edges[1]),
    show("feed", m.shared.nodes.feed),
    show("e6", m.shared.edges[2]),
    show("board", m.shared.nodes.board),
  ];
}

const ALL_GREEN = [
  "iracing green",
  "e1 green",
  "agent green",
  "e2 green",
  "network green",
  "e3 green",
  "server green",
  "e4 green",
  "database green",
  "e5 green",
  "feed green",
  "e6 green",
  "board green",
];

describe("RULE_PLACE", () => {
  it("gives every rule a node or an edge", () => {
    for (const rule of Object.keys(RULES) as Array<keyof typeof RULES>) {
      const place = RULE_PLACE[rule];
      expect(place.node ?? place.edge, rule).toBeDefined();
    }
  });
});

describe("flowModel", () => {
  it("draws a healthy rig green end to end, with nothing broken", () => {
    const m = model(snapshot([rig(1, minutely(14 * MIN))]));
    expect(states(m)).toEqual(ALL_GREEN);
    expect(m.lanes[0]!.broken).toBeNull();
    expect(m.shared.broken).toBeNull();
    expect(m.lanes[0]!.label).toBe("R01");
  });

  it("breaks a silent rig at the network edge and fades what it cannot judge past it", () => {
    const m = model(snapshot([rig(1, minutely(14 * MIN, 5 * MIN))]));
    const lane = m.lanes[0]!;
    expect(lane.broken).toBe(2);
    expect(states(m).slice(0, 6)).toEqual([
      "iracing grey",
      "e1 grey",
      "agent red",
      "e2 red",
      "network grey dim",
      "e3 grey dim",
    ]);
    expect(lane.edges[1].reason).toBe("Rig 01 has been silent for 5 min with Matt G signed in");
  });

  it("breaks at iRacing when the sim is down with a driver seated", () => {
    const hbs = [...minutely(14 * MIN, 6 * MIN), ...minutely(5 * MIN, 0, { simConnected: false, session: null })];
    const m = model(snapshot([rig(1, hbs)]));
    expect(m.lanes[0]!.broken).toBe(1);
    expect(states(m).slice(0, 6)).toEqual([
      "iracing red",
      "e1 red",
      "agent green dim",
      "e2 green dim",
      "network green dim",
      "e3 green dim",
    ]);
    expect(m.lanes[0]!.edges[0].reason).toMatch(/iRacing not connected for 5 min while Matt G/);
  });

  it("breaks at the server when laps wait on a rig whose heartbeats arrive, and shows them queued", () => {
    const hbs = [
      ...minutely(14 * MIN, 1 * MIN),
      hb(0, { pendingLaps: 3, oldestPendingAgeS: 300 }),
    ];
    hbs.slice(-4, -1).forEach((h) => Object.assign(h, { pendingLaps: 2, oldestPendingAgeS: 200 }));
    const m = model(snapshot([rig(1, hbs)]));
    const lane = m.lanes[0]!;
    expect(lane.broken).toBe(3);
    expect(states(m).slice(0, 6)).toEqual([
      "iracing green",
      "e1 green",
      "agent green",
      "e2 green",
      "network green",
      "e3 red",
    ]);
    expect(lane.held).toEqual([{ status: "queued", count: 3 }]);
  });

  it("shows laps the site refused as held at the server", () => {
    const m = model(snapshot([rig(1, minutely(14 * MIN, 0, { rejectedLaps: 2 }))]));
    expect(m.lanes[0]!.broken).toBe(3);
    expect(m.lanes[0]!.held).toEqual([{ status: "refused", count: 2 }]);
  });

  it("breaks the shared half at the feed with no combo, fading the board past it", () => {
    const m = model(snapshot([rig(1, minutely(14 * MIN))], { featuredCombo: null }));
    expect(m.shared.broken).toBe(5);
    expect(states(m).slice(6)).toEqual([
      "server green",
      "e4 green",
      "database green",
      "e5 red",
      "feed red",
      "e6 green dim",
      "board green dim",
    ]);
    expect(m.shared.edges[1].reason).toMatch(/^No featured car and track is set for today/);
    // The rig's own lane is not the problem.
    expect(m.lanes[0]!.broken).toBeNull();
  });

  it("breaks at the board when the event board goes dark", () => {
    const m = model(
      snapshot([rig(1, minutely(14 * MIN))], { boards: [board({ lastSeenAt: NOW - 5 * MIN })] }),
    );
    expect(m.shared.broken).toBe(6);
    expect(states(m).slice(9)).toEqual(["e5 green", "feed green", "e6 red", "board red"]);
  });

  it("leaves the board grey, not broken, when no board is open outside event mode", () => {
    const m = model(snapshot([rig(1, minutely(14 * MIN))], { boards: [] }));
    expect(states(m).slice(11)).toEqual(["e6 grey", "board grey"]);
    expect(m.shared.broken).toBeNull();
  });

  it("marks a warning without cutting the chain", () => {
    const hbs = minutely(14 * MIN, 0, { missingVariables: ["PlayerCarMyIncidentCount"] });
    const m = model(snapshot([rig(1, hbs)]));
    expect(m.lanes[0]!.broken).toBe(1);
    expect(states(m).slice(0, 6)).toEqual([
      "iracing yellow",
      "e1 yellow",
      "agent green",
      "e2 green",
      "network green",
      "e3 green",
    ]);
  });

  it("puts rig-agent findings on the agent node, not on an edge", () => {
    const m = model(snapshot([rig(1, minutely(14 * MIN, 0, { agentMemoryMb: 200 }))]));
    expect(m.lanes[0]!.nodes.agent.state).toBe("yellow");
    expect(m.lanes[0]!.broken).toBeNull();
  });

  it("places a finding about something finer than the rig on that rig (rule 11, per build)", () => {
    const m = model(snapshot([rig(1, minutely(14 * MIN, 0, { agentVersion: "rig-agent/0.1-old" }))]));
    expect(m.lanes[0]!.nodes.agent).toMatchObject({ state: "yellow", reason: expect.stringMatching(/outdated rig agent/) });
  });

  it("keeps drawing an alert the channel still has open, as the tiles do (shownFindings)", () => {
    const snap = snapshot([rig(1, minutely(14 * MIN))]);
    const open = [
      {
        rule: "rig_silent",
        subject: "rig:rig-1",
        severity: "urgent" as const,
        detail: { headline: "Rig 01 has been silent for 3 min", where: "Rig 01", fields: [] },
      },
    ];
    const m = flowModel(snap, shownFindings(evaluateRules(snap), open), NOW - 20 * S);
    expect(m.lanes[0]!.broken).toBe(2);
    expect(m.lanes[0]!.edges[1]).toMatchObject({ state: "red", reason: "Rig 01 has been silent for 3 min" });
  });

  it("does not let a warning upstream hide a red break further down", () => {
    const m = model(
      snapshot([rig(1, minutely(14 * MIN, 0, { missingVariables: ["X"], rejectedLaps: 1 }))]),
    );
    expect(m.lanes[0]!.broken).toBe(3);
  });

  it("marks the database yellow when the monitor stopped running", () => {
    const m = model(snapshot([rig(1, minutely(14 * MIN))]), NOW - 30 * MIN);
    expect(m.shared.broken).toBe(4);
    expect(m.shared.nodes.database.state).toBe("yellow");
    expect(m.shared.edges[0].reason).toMatch(/has not run for 30 min/);
  });

  it("draws the venue-closed note on each rig that went quiet", () => {
    const quiet = (n: number, lastAgo: number) =>
      rig(n, minutely(lastAgo + 5 * MIN, lastAgo), { seated: null });
    const m = model(snapshot([quiet(1, 10 * MIN), quiet(2, 8 * MIN)], { boards: [] }));
    expect(m.lanes.map((l) => [l.broken, l.edges[1].state])).toEqual([
      [2, "yellow"],
      [2, "yellow"],
    ]);
  });

  it("carries the last ten minutes of traffic, placed by age, with each lap's status", () => {
    const laps = [
      lap("a", "rig-1", 1 * MIN, 137_217, "accepted"),
      lap("b", "rig-1", 4 * MIN, 140_001, "invalid"),
      lap("c", "rig-1", 6 * MIN, 139_500, "unattributed"),
      lap("d", "rig-1", 11 * MIN, 138_000, "accepted"),
      lap("e", "rig-2", 1 * MIN, 150_000, "accepted"),
    ];
    const m = model(snapshot([rig(1, minutely(14 * MIN))], { laps }));
    const traffic = m.lanes[0]!.traffic;
    expect(traffic.filter((t) => t.kind === "heartbeat").map((t) => t.ageMs)).toEqual(
      [9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((n) => n * MIN),
    );
    expect(traffic.filter((t) => t.kind === "lap")).toEqual([
      { kind: "lap", id: "a", ageMs: 1 * MIN, lapTimeMs: 137_217, status: "accepted" },
      { kind: "lap", id: "b", ageMs: 4 * MIN, lapTimeMs: 140_001, status: "invalid" },
      { kind: "lap", id: "c", ageMs: 6 * MIN, lapTimeMs: 139_500, status: "unattributed" },
    ]);
  });

  it("shows a rig that never reported as grey with no traffic", () => {
    const m = model(snapshot([rig(1, [], { seated: null, lastSeenAt: null })]));
    expect(states(m).slice(0, 6)).toEqual([
      "iracing grey",
      "e1 grey",
      "agent grey",
      "e2 grey",
      "network grey",
      "e3 grey",
    ]);
    expect(m.lanes[0]!.traffic).toEqual([]);
    expect(m.lanes[0]!.broken).toBeNull();
  });
});
