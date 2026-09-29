import { boardState, boardsToday } from "./event-mode";
import { isRunning, rigLabel } from "./rig-health";
import { rigState } from "./rig-state";
import {
  duration,
  monitorGap,
  rigSubject,
  type Finding,
  type MonitorSnapshot,
  type RuleKey,
  type Severity,
} from "./rules";

/**
 * The staff Rig health page's data-flow view (owner's decision R10): every rig
 * drawn as the pipeline its laps travel,
 *
 *   iRacing -1-> rig agent -2-> network -3-> server -4-> database -5-> feed -6-> TV board
 *
 * with each node and edge coloured from the same findings the tiles and the
 * Discord channel come from (evaluateRules), so the picture cannot disagree
 * with either. This module only places what the rules found; it judges
 * nothing itself. The server, database, feed and board are shared by every
 * rig, so they are modelled (and drawn) once.
 *
 * Pure, like the rules: the page passes the snapshot, the findings and the
 * laps it already reads, and every state is tested from a hand-built snapshot.
 */

export type FlowState = "green" | "yellow" | "red" | "grey";

export type FlowPart = {
  state: FlowState;
  /** The finding that coloured it, as its alert's headline; null otherwise. */
  reason: string | null;
  /**
   * Downstream of a red edge: nothing here can be judged once the chain is
   * cut, so it is drawn faded rather than coloured - unless a rule found
   * something here too, which stays shown as the tiles show it.
   */
  dimmed: boolean;
};

export type RigNode = "iracing" | "agent" | "network";
export type SharedNode = "server" | "database" | "feed" | "board";
export type Edge = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Where each rule's finding is drawn. A Record over every RuleKey, so a new
 * rule does not compile until it is given a place in the picture. Rule 9 (the
 * site or database down) has no entry because it is not evaluated by the
 * site: a page that rendered is its own proof the server and database
 * answered. Rule 9b (monitor gap) is not a finding either; flowModel reads it
 * from the clock (monitorGap).
 */
export const RULE_PLACE: Record<RuleKey, { node?: RigNode | SharedNode; edge?: Edge }> = {
  sim_disconnected: { node: "iracing", edge: 1 },
  telemetry_faulted: { node: "iracing", edge: 1 },
  missing_variables: { node: "iracing", edge: 1 },
  agent_restarting: { node: "agent" },
  footprint_high: { node: "agent" },
  checkout_not_saved: { node: "agent" },
  rig_silent: { node: "agent", edge: 2 },
  // Its subject is the venue; it is drawn on each rig that went quiet.
  venue_silent: { edge: 2 },
  clock_skew: { node: "network", edge: 2 },
  // The rig reaches the site (its heartbeats arrive) and its laps are not
  // being stored: the break is at the server, not on the network.
  laps_stuck: { edge: 3 },
  laps_refused: { edge: 3 },
  no_featured_combo: { node: "feed", edge: 5 },
  board_dark: { node: "board", edge: 6 },
  board_feed_failing: { node: "board", edge: 6 },
};

/**
 * Traffic is drawn from this far back. A dot's place along its route is its
 * age over this window: fresh at the start, this old at the end.
 */
export const TRAFFIC_WINDOW_MS = 10 * 60_000;

/** A stored lap, as the page reads it (store.ts rigLaps). */
export type FlowLap = {
  id: string;
  rigId: string;
  /** created_at: when the site stored it, on the database's clock. */
  receivedAt: number;
  lapTimeMs: number;
  valid: boolean;
  unattributed: boolean;
};

export type LapStatus = "accepted" | "invalid" | "unattributed";

/**
 * Something moving along a route. A heartbeat rides edges 2-3, rig agent to
 * server. A lap rides from iRacing to where it stopped: a lap that ranks to
 * the feed, one stored but not ranked (invalid, or nobody signed in) to the
 * database.
 */
export type Traveller =
  | { kind: "heartbeat"; id: string; ageMs: number; goodbye: boolean }
  | { kind: "lap"; id: string; ageMs: number; lapTimeMs: number; status: LapStatus };

/** Laps that have not moved: still in the rig's outbox, or refused by the site and parked. */
export type HeldLaps = { status: "queued" | "refused"; count: number };

export type FlowLane = {
  rigId: string;
  label: string;
  nodes: Record<RigNode, FlowPart>;
  /** Edges 1-3. */
  edges: [FlowPart, FlowPart, FlowPart];
  broken: 1 | 2 | 3 | null;
  traffic: Traveller[];
  held: HeldLaps[];
};

export type FlowModel = {
  now: number;
  lanes: FlowLane[];
  shared: {
    nodes: Record<SharedNode, FlowPart>;
    /** Edges 4-6. */
    edges: [FlowPart, FlowPart, FlowPart];
    broken: 4 | 5 | 6 | null;
  };
};

const RIG_NODES: RigNode[] = ["iracing", "agent", "network"];
const SHARED_NODES: SharedNode[] = ["server", "database", "feed", "board"];

export function flowModel(
  snapshot: MonitorSnapshot,
  findings: readonly Finding[],
  input: { laps: readonly FlowLap[]; lastEvaluatedAt: number | null },
): FlowModel {
  const { now } = snapshot;
  const venueSilent = findings.find((f) => f.rule === "venue_silent");

  const lanes = snapshot.rigs.map((rig): FlowLane => {
    const state = rigState(rig.heartbeats);
    const running = isRunning(now, rig, state);
    const base = (on: boolean): FlowPart => part(on ? "green" : "grey");
    const nodes: Record<RigNode, FlowPart> = {
      iracing: base(running && state?.simConnected === true),
      agent: base(running),
      network: base(running),
    };
    // Each edge starts as its source node: whatever runs there is reaching it.
    const edges: FlowLane["edges"] = [
      base(running && state?.simConnected === true),
      base(running),
      base(running),
    ];

    const mine = findings.filter((f) => f.subject === rigSubject(rig.id));
    // A quiet rig, not closed on purpose, that the venue note covers.
    if (venueSilent && rig.lastSeenAt !== null && !running && !state?.shuttingDown) {
      mine.push(venueSilent);
    }
    for (const f of mine) {
      const place = RULE_PLACE[f.rule];
      if (place.node && place.node in nodes) mark(nodes[place.node as RigNode], f);
      if (place.edge && place.edge <= 3) mark(edges[place.edge - 1]!, f);
    }

    const broken = firstBroken(edges);
    if (broken !== null && edges[broken - 1]!.state === "red") {
      // Edge n runs into node n (iracing is node 0).
      edges.slice(broken).forEach(dim);
      RIG_NODES.slice(broken).forEach((n) => dim(nodes[n]));
    }

    return {
      rigId: rig.id,
      label: rigLabel(rig),
      nodes,
      edges,
      broken: broken as FlowLane["broken"],
      traffic: [
        ...rig.heartbeats
          .filter((h) => now - h.receivedAt < TRAFFIC_WINDOW_MS)
          .map((h): Traveller => ({
            kind: "heartbeat",
            id: h.id,
            ageMs: Math.max(0, now - h.receivedAt),
            goodbye: h.shuttingDown,
          })),
        ...input.laps
          .filter((l) => l.rigId === rig.id && now - l.receivedAt < TRAFFIC_WINDOW_MS)
          .map((l): Traveller => ({
            kind: "lap",
            id: l.id,
            ageMs: Math.max(0, now - l.receivedAt),
            lapTimeMs: l.lapTimeMs,
            status: l.valid ? "accepted" : l.unattributed ? "unattributed" : "invalid",
          })),
      ],
      held: [
        { status: "queued" as const, count: state?.pendingLaps ?? 0 },
        { status: "refused" as const, count: state?.rejectedLaps ?? 0 },
      ].filter((h) => h.count > 0),
    };
  });

  return { now, lanes, shared: sharedParts(snapshot, findings, input.lastEvaluatedAt) };
}

function sharedParts(
  snapshot: MonitorSnapshot,
  findings: readonly Finding[],
  lastEvaluatedAt: number | null,
): FlowModel["shared"] {
  const { now } = snapshot;
  const liveBoard = boardsToday(snapshot).some(
    (b) => boardState(b, now) === "live" && b.feedOk !== false,
  );
  const nodes: Record<SharedNode, FlowPart> = {
    // This page was served from the database's answers.
    server: part("green"),
    database: part("green"),
    feed: part(snapshot.featuredCombo ? "green" : "grey"),
    board: part(liveBoard ? "green" : "grey"),
  };
  const edges: FlowModel["shared"]["edges"] = [
    part("green"),
    part(snapshot.featuredCombo ? "green" : "grey"),
    part(liveBoard ? "green" : "grey"),
  ];

  const gap = monitorGap(lastEvaluatedAt, now);
  if (gap) {
    const reason = `The monitor has not run for ${duration(gap.to - gap.from)} - is the outside clock calling the tick?`;
    for (const p of [nodes.database, edges[0]]) Object.assign(p, { state: "yellow", reason });
  }

  // Only venue and board rules have a place here; a rig's are on its lane.
  const shared = new Set<string>(SHARED_NODES);
  for (const f of findings) {
    const place = RULE_PLACE[f.rule];
    if (place.node && shared.has(place.node)) mark(nodes[place.node as SharedNode], f);
    if (place.edge && place.edge >= 4) mark(edges[place.edge - 4]!, f);
  }

  const index = firstBroken(edges);
  if (index !== null && edges[index - 1]!.state === "red") {
    edges.slice(index).forEach(dim);
    // Edge 4 runs into the database, shared node 1.
    SHARED_NODES.slice(index).forEach((n) => dim(nodes[n]));
  }
  return { nodes, edges, broken: index === null ? null : ((index + 3) as 4 | 5 | 6) };
}

/**
 * The edge to draw as broken, 1-based within `edges`: the first red one
 * walking downstream, or when none is red, the first yellow one. A warning
 * does not cut the chain - laps still flow past an outdated build or a clock
 * that is merely drifting - so only a red break dims what lies beyond it, and
 * a yellow one never hides a red one further down.
 */
function firstBroken(edges: readonly FlowPart[]): number | null {
  for (const state of ["red", "yellow"] as const) {
    const i = edges.findIndex((e) => e.state === state);
    if (i >= 0) return i + 1;
  }
  return null;
}

function part(state: FlowState): FlowPart {
  return { state, reason: null, dimmed: false };
}

const COLOUR: Record<Severity, FlowState> = { urgent: "red", warning: "yellow" };

/** The worst finding on a part colours it; the first of equals gives the reason. */
function mark(p: FlowPart, f: Finding) {
  const state = COLOUR[f.severity];
  if (p.reason !== null && (p.state === "red" || state === "yellow")) return;
  p.state = state;
  p.reason = f.detail.headline;
}

function dim(p: FlowPart) {
  if (p.reason === null) p.dimmed = true;
}
