import { boardState, boardsToday } from "./event-mode";
import { isRunning, rigFindings, rigLabel } from "./rig-health";
import { rigState, type Heartbeat } from "./rig-state";
import {
  duration,
  monitorGap,
  type AlertDetail,
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
 * Pure, like the rules: the page passes the snapshot and the findings it shows
 * the tiles (shownFindings: fresh findings and alerts still open), and the
 * traffic is the snapshot's own heartbeats and laps, so the view adds no
 * query. Every state is tested from a hand-built snapshot.
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
 * Where a finding is drawn, by what its evidence points at:
 * - a node and/or an edge of the pipeline, where something is broken or
 *   wrong in the path a lap travels;
 * - a mark on the rig's lane, for laps that travelled the whole path and
 *   were stored, but will not rank ("feed": they stop at the database) or
 *   rank pending a person's look ("review"). Neither claims a break;
 * - the venue: a venue-wide finding is no single rig's, and the page lists
 *   it under Venue rather than on every lane.
 */
export type Place =
  | { node?: RigNode | SharedNode; edge?: Edge }
  | { mark: Mark }
  | { venue: true };

export type Mark = "feed" | "review";

/**
 * Where each rule's finding is drawn. A Record over every RuleKey, so a new
 * rule does not compile until it is given a place in the picture. Rule 9 (the
 * site or database down) has no entry because it is not evaluated by the
 * site: a page that rendered is its own proof the server and database
 * answered. Rule 9b (monitor gap) is not a finding either; flowModel reads it
 * from the clock (monitorGap).
 */
export const RULE_PLACE: Record<RuleKey, Place | ((detail: AlertDetail) => Place)> = {
  sim_disconnected: { node: "iracing", edge: 1 },
  telemetry_faulted: { node: "iracing", edge: 1 },
  missing_variables: { node: "iracing", edge: 1 },
  // The stint it left ended while that rig's sim is still in a session.
  driver_moved: { node: "iracing" },
  // Rule 7 from the live session is iRacing running the wrong car or track;
  // from stored laps (and an alert opened before rules said which), the laps
  // arrived and were stored, and will not rank.
  wrong_combo: (detail) => (detail.evidence === "session" ? { node: "iracing", edge: 1 } : { mark: "feed" }),
  agent_restarting: { node: "agent" },
  footprint_high: { node: "agent" },
  checkout_not_saved: { node: "agent" },
  agent_outdated: { node: "agent" },
  sign_in_failures: { node: "agent" },
  long_stint: { node: "agent" },
  rig_silent: { node: "agent", edge: 2 },
  clock_skew: { node: "network", edge: 2 },
  // The rig reaches the site (its heartbeats arrive) and its laps are not
  // being stored: the break is at the server, not on the network.
  laps_stuck: { edge: 3 },
  laps_refused: { edge: 3 },
  // Stored with nobody to credit them to: they stop short of the feed.
  unattributed_laps: { mark: "feed" },
  // It ranks; staff decide whether it stands.
  fast_lap: { mark: "review" },
  venue_silent: { venue: true },
  no_featured_combo: { node: "feed", edge: 5 },
  board_dark: { node: "board", edge: 6 },
  board_feed_failing: { node: "board", edge: 6 },
};

export function placeOf(f: Pick<Finding, "rule" | "detail">): Place {
  const place = RULE_PLACE[f.rule];
  return typeof place === "function" ? place(f.detail) : place;
}

/**
 * Traffic is drawn from this far back. A dot's place along its route is its
 * age over this window: fresh at the start, this old at the end.
 */
export const TRAFFIC_WINDOW_MS = 10 * 60_000;

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

/** A lane's data-quality mark: the worst finding placed there. */
export type FlowMark = { mark: Mark; state: "red" | "yellow"; reason: string };

export type FlowLane = {
  rigId: string;
  label: string;
  nodes: Record<RigNode, FlowPart>;
  /** Edges 1-3. */
  edges: [FlowPart, FlowPart, FlowPart];
  broken: 1 | 2 | 3 | null;
  traffic: Traveller[];
  held: HeldLaps[];
  marks: FlowMark[];
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
const MARKS: Mark[] = ["feed", "review"];
const SHARED_NODES: SharedNode[] = ["server", "database", "feed", "board"];

export function flowModel(
  snapshot: MonitorSnapshot,
  findings: readonly Finding[],
  lastEvaluatedAt: number | null,
): FlowModel {
  const { now } = snapshot;

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

    const marks: FlowMark[] = [];
    for (const f of rigFindings(findings, rig.id)) {
      const place = placeOf(f);
      if ("venue" in place) continue;
      if ("mark" in place) {
        const state = COLOUR[f.severity];
        const at = marks.find((m) => m.mark === place.mark);
        if (!at) marks.push({ mark: place.mark, state, reason: f.detail.headline });
        else if (at.state === "yellow" && state === "red") Object.assign(at, { state, reason: f.detail.headline });
        continue;
      }
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
        ...heartbeatMarkers(rig.heartbeats, now).map((h): Traveller => ({
          kind: "heartbeat",
          id: h.id,
          ageMs: Math.max(0, now - h.receivedAt),
          goodbye: h.shuttingDown,
        })),
        ...snapshot.laps
          .filter((l) => l.rigId === rig.id && now - l.receivedAt < TRAFFIC_WINDOW_MS)
          .map((l): Traveller => ({
            kind: "lap",
            id: l.id,
            ageMs: Math.max(0, now - l.receivedAt),
            lapTimeMs: l.lapTimeMs,
            status: l.valid ? "accepted" : l.driver === null ? "unattributed" : "invalid",
          })),
      ],
      marks: marks.sort((a, b) => MARKS.indexOf(a.mark) - MARKS.indexOf(b.mark)),
      held: [
        { status: "queued" as const, count: state?.pendingLaps ?? 0 },
        { status: "refused" as const, count: state?.rejectedLaps ?? 0 },
      ].filter((h) => h.count > 0),
    };
  });

  return { now, lanes, shared: sharedParts(snapshot, findings, lastEvaluatedAt) };
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
    const place = placeOf(f);
    if ("venue" in place || "mark" in place) continue;
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
 * A rig heartbeats every minute, so ten minutes of them is ten dots a lane and
 * hundreds of moving markers at twenty-five rigs. At most one is drawn per
 * HEARTBEAT_MARKER_EVERY_MS, newest first: a goodbye always, since it says
 * how the stream ended. The spacing still shows a steady stream, a gap, or a
 * rig backing off.
 */
export const HEARTBEAT_MARKER_EVERY_MS = 2.5 * 60_000;

function heartbeatMarkers(heartbeats: readonly Heartbeat[], now: number): Heartbeat[] {
  const kept: Heartbeat[] = [];
  for (let i = heartbeats.length - 1; i >= 0; i--) {
    const h = heartbeats[i]!;
    if (now - h.receivedAt >= TRAFFIC_WINDOW_MS) break;
    const last = kept.at(-1);
    if (!last || h.shuttingDown || last.receivedAt - h.receivedAt >= HEARTBEAT_MARKER_EVERY_MS) kept.push(h);
  }
  return kept.reverse();
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

const COLOUR: Record<Severity, "red" | "yellow"> = { urgent: "red", warning: "yellow" };

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
