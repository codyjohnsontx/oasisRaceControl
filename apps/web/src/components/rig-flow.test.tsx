import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CURRENT_AGENT_VERSION } from "@/lib/monitor/agent-version";
import { flowModel, type FlowLane, type FlowModel, type FlowPart } from "@/lib/monitor/flow";
import type { Heartbeat } from "@/lib/monitor/rig-state";
import { evaluateRules, type LapSnapshot, type MonitorSnapshot, type RigSnapshot } from "@/lib/monitor/rules";
import { RigFlow } from "./rig-flow";

/**
 * The data-flow view as served. Which part is which colour, and which edge is
 * broken, is decided in lib/monitor/flow.ts (its tests); here what must hold
 * is that the markup carries those states, the broken edge and its reason,
 * and that traffic is placed by age - started that far along its route, with
 * a still fallback for reduced motion - wearing each lap's status and time.
 */

const part = (state: FlowPart["state"], extra: Partial<FlowPart> = {}): FlowPart => ({
  state,
  reason: null,
  dimmed: false,
  ...extra,
});

function lane(overrides: Partial<FlowLane> = {}): FlowLane {
  return {
    rigId: "rig-1",
    label: "R01",
    nodes: { iracing: part("green"), agent: part("green"), network: part("green") },
    edges: [part("green"), part("green"), part("green")],
    broken: null,
    traffic: [],
    held: [],
    marks: [],
    ...overrides,
  };
}

function model(lanes: FlowLane[], shared: Partial<FlowModel["shared"]> = {}): FlowModel {
  return {
    now: 1_000_000,
    lanes,
    shared: {
      nodes: { server: part("green"), database: part("green"), feed: part("green"), board: part("green") },
      edges: [part("green"), part("green"), part("green")],
      broken: null,
      ...shared,
    },
  };
}

describe("RigFlow", () => {
  const html = renderToStaticMarkup(
    <RigFlow
      model={model([
        lane({
          traffic: [
            { kind: "heartbeat", id: "h1", ageMs: 30_000, goodbye: false },
            { kind: "heartbeat", id: "h2", ageMs: 90_000, goodbye: false },
            { kind: "lap", id: "l1", ageMs: 60_000, lapTimeMs: 137_217, status: "accepted" },
            { kind: "lap", id: "l2", ageMs: 540_000, lapTimeMs: 140_001, status: "invalid" },
            { kind: "lap", id: "l3", ageMs: 240_000, lapTimeMs: 138_000, status: "accepted" },
          ],
        }),
        lane({
          rigId: "rig-2",
          label: "R02",
          nodes: { iracing: part("grey"), agent: part("red"), network: part("grey", { dimmed: true }) },
          edges: [
            part("grey"),
            part("red", { reason: "Rig 02 has been silent for 4 min" }),
            part("grey", { dimmed: true }),
          ],
          broken: 2,
          held: [{ status: "queued", count: 3 }],
        }),
      ])}
    />,
  );

  it("draws each rig's lane with its parts' states", () => {
    expect(html).toContain('data-rig="R01"');
    expect(html).toContain('data-rig="R02"');
    expect(html.match(/class="flow-edge"[^>]*data-state="red"[^>]*data-broken="true"/g)).toHaveLength(1);
    expect(html).toMatch(/class="flow-node"[^>]*data-state="red"/);
    expect(html).toMatch(/data-state="grey" data-dimmed="true"/);
  });

  it("writes the broken edge's reason under its lane", () => {
    expect(html).toMatch(/class="flow-reason[^"]*" data-state="red"[^>]*>Rig 02 has been silent for 4 min/);
  });

  it("starts each dot as far along its route as its age, and still under reduced motion", () => {
    expect(html).toMatch(/data-kind="heartbeat" style="offset-path:path\(&quot;M 230 /);
    expect(html).toContain("animation-delay:-30s;--at:5.00%");
    expect(html).toContain("animation-delay:-60s;--at:10.00%");
    expect(html).toContain("@media (prefers-reduced-motion: reduce)");
    expect(html).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.flow-dot \{ animation: none; offset-distance: var\(--at\); \}/);
  });

  it("moves only a lane's newest heartbeat and leaves the older ones where their age puts them", () => {
    expect(html.match(/data-kind="heartbeat"/g)).toHaveLength(2);
    expect(html).toMatch(/data-kind="heartbeat" style="[^"]*animation-delay:-30s;--at:5.00%"/);
    expect(html).toMatch(/data-kind="heartbeat" data-still="true" style="offset-path:[^"]*;--at:15.00%"/);
    expect(html).not.toContain("animation-delay:-90s");
    expect(html).toMatch(/\.flow-dot\[data-still\] \{ animation: none; offset-distance: var\(--at\); \}/);
  });

  it("labels a lap with its status and its time while it is on its rig's lane", () => {
    expect(html).toMatch(/data-kind="lap" data-status="accepted"[^>]*><circle r="4.5"><\/circle><text y="-13">2:17.217</);
    // Past its network node - four minutes on, curving into the server, or
    // nine, on the shared line - its time would print over other rigs' laps
    // and the converging edges, so it is not labelled.
    expect(html).toMatch(/data-status="invalid"[^>]*><circle r="4.5"><\/circle><\/g>/);
    expect(html).not.toContain("2:20.001");
    expect(html).not.toContain("2:18.000");
  });

  it("shows laps held on the rig", () => {
    expect(html).toMatch(/class="flow-held" data-status="queued"[^>]*><circle r="4.5"><\/circle><text y="-13">3 queued</);
  });

  it("drops a lap's label that would print over a newer lap's or the queued badge, and keeps its dot", () => {
    // A lap a minute: the invalid one rides the shorter route, to the
    // database, so a minute older it sits about a label's width further on.
    const busy = renderToStaticMarkup(
      <RigFlow
        model={model([
          lane({
            traffic: [
              { kind: "lap", id: "l1", ageMs: 60_000, lapTimeMs: 138_058, status: "accepted" },
              { kind: "lap", id: "l2", ageMs: 120_000, lapTimeMs: 143_315, status: "invalid" },
            ],
          }),
        ])}
      />,
    );
    expect(busy).toContain("2:18.058");
    expect(busy).not.toContain("2:23.315");
    expect(busy).toMatch(/data-status="invalid"[^>]*><circle r="4.5"><\/circle><\/g>/);

    const queued = renderToStaticMarkup(
      <RigFlow
        model={model([
          lane({
            traffic: [{ kind: "lap", id: "l1", ageMs: 120_000, lapTimeMs: 141_946, status: "accepted" }],
            held: [{ status: "queued", count: 1 }],
          }),
        ])}
      />,
    );
    expect(queued).toContain("1 queued");
    expect(queued).not.toContain("2:21.946");
    expect(queued.match(/data-kind="lap"/g)).toHaveLength(1);
  });

  it("judges label spacing up to the next refresh, since the dots keep moving until then", () => {
    // 85 s old, this lap's label clears the queued badge as the page renders
    // and runs into it about ten seconds before the next 15 s refresh.
    const approaching = renderToStaticMarkup(
      <RigFlow
        model={model([
          lane({
            traffic: [{ kind: "lap", id: "l1", ageMs: 85_000, lapTimeMs: 138_058, status: "accepted" }],
            held: [{ status: "queued", count: 1 }],
          }),
        ])}
      />,
    );
    expect(approaching).toContain("1 queued");
    expect(approaching).not.toContain("2:18.058");

    // An accepted lap rides a longer route, so it gains on an older invalid
    // one ahead of it: a label's width apart now, closer by the refresh.
    const closing = renderToStaticMarkup(
      <RigFlow
        model={model([
          lane({
            traffic: [
              { kind: "lap", id: "l1", ageMs: 30_000, lapTimeMs: 138_058, status: "accepted" },
              { kind: "lap", id: "l2", ageMs: 91_000, lapTimeMs: 143_315, status: "invalid" },
            ],
          }),
        ])}
      />,
    );
    expect(closing).toContain("2:18.058");
    expect(closing).not.toContain("2:23.315");
  });

  it("writes a shared break's reason under the shared nodes", () => {
    const shared = renderToStaticMarkup(
      <RigFlow
        model={model([lane()], {
          edges: [part("green"), part("red", { reason: "No featured car and track is set for today" }), part("green", { dimmed: true })],
          nodes: { server: part("green"), database: part("green"), feed: part("red"), board: part("green", { dimmed: true }) },
          broken: 5,
        })}
      />,
    );
    expect(shared).toContain("No featured car and track is set for today");
    expect(shared.match(/data-broken="true"/g)).toHaveLength(1);
  });

  it("draws a lane's data-quality mark under its label, and its headline when nothing is broken", () => {
    const marked = renderToStaticMarkup(
      <RigFlow
        model={model([
          lane({
            marks: [{ mark: "feed", state: "red", reason: "Rig 01: 2 laps landed with nobody signed in" }],
          }),
        ])}
      />,
    );
    expect(marked).toMatch(/class="flow-mark[^"]*" data-mark="feed" data-state="red"[^>]*>◆ won&#x27;t rank/);
    expect(marked).toMatch(/class="flow-reason[^"]*" data-state="red"[^>]*>Rig 01: 2 laps landed with nobody signed in/);
    expect(marked).not.toContain('data-broken="true"');
  });
});

/**
 * The venue runs 20-25 rigs, each heartbeating every minute. Rendered from the
 * real model, twenty-five busy lanes draw every heartbeat and lap of the last
 * ten minutes, but stay a bounded number of moving markers: one heartbeat a
 * lane, and the laps.
 */
describe("RigFlow at twenty-five rigs", () => {
  const NOW = Date.parse("2026-10-04T21:00:00Z");
  const MIN = 60_000;
  const heartbeat = (rigId: string, ago: number): Heartbeat => ({
    id: `${rigId}-${ago}`,
    receivedAt: NOW - ago,
    sentAt: NOW - ago,
    clockSkewMs: 0,
    processStartedAt: NOW - 3 * 60 * MIN,
    sequence: 1_000 - ago / MIN,
    agentVersion: CURRENT_AGENT_VERSION,
    telemetryMode: "iracing",
    simConnected: true,
    telemetryFaulted: false,
    session: null,
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
  });
  const rigs: RigSnapshot[] = Array.from({ length: 25 }, (_, i) => {
    const id = `rig-${i + 1}`;
    const heartbeats = Array.from({ length: 15 }, (_, k) => heartbeat(id, (14 - k) * MIN));
    return {
      id,
      number: i + 1,
      name: `Rig ${i + 1}`,
      lastSeenAt: NOW,
      seated: null,
      heartbeats,
      heard: [{ from: heartbeats[0]!.receivedAt, to: NOW }],
    };
  });
  const laps: LapSnapshot[] = rigs.flatMap((r) =>
    [1, 3, 5, 7, 9].map((ago) => ({
      id: `${r.id}-lap-${ago}`,
      rigId: r.id,
      receivedAt: NOW - ago * MIN,
      driver: { id: "d", name: "Matt G", status: "active" },
      combo: { trackName: "Spa", trackConfig: null, carName: "Porsche" },
      lapTimeMs: 137_000,
      valid: true,
      invalidReason: null,
      unattributedCause: null,
    })),
  );
  const snap: MonitorSnapshot = {
    now: NOW,
    venueDayStart: NOW - 16 * 60 * MIN,
    rigs,
    featuredCombo: { trackName: "Spa", trackConfig: null, carName: "Porsche" },
    longStintMinutes: 120,
    laps,
    lapBests: [],
    moves: [],
    override: null,
    eventModeSince: null,
    boards: [],
    openAlerts: [],
  };
  const flow = flowModel(snap, evaluateRules(snap), NOW);
  const html = renderToStaticMarkup(<RigFlow model={flow} />);

  it("draws every heartbeat and lap, moving one heartbeat a lane and every lap", () => {
    expect(flow.lanes).toHaveLength(25);
    for (const l of flow.lanes) {
      expect(l.traffic.filter((t) => t.kind === "heartbeat").length, l.label).toBe(10);
    }
    expect(html.match(/data-kind="heartbeat"/g)).toHaveLength(25 * 10);
    expect(html.match(/data-still="true"/g)).toHaveLength(25 * 9);
    expect(html.match(/animation-delay:/g)).toHaveLength(25 + 25 * 5);
    expect(html.match(/data-kind="lap"/g)).toHaveLength(25 * 5);
    expect(html).not.toMatch(/class="flow-dot"[^>]*filter/);
  });
});

