import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { FlowLane, FlowModel, FlowPart } from "@/lib/monitor/flow";
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
});
