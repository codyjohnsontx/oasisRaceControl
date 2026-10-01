import type { CSSProperties } from "react";
import {
  TRAFFIC_WINDOW_MS,
  type FlowLane,
  type FlowModel,
  type FlowPart,
  type HeldLaps,
  type Mark,
  type Traveller,
} from "@/lib/monitor/flow";
import { formatLapTime } from "@/lib/time";

/**
 * The data-flow view (R10): one pipeline per rig, drawn as inline SVG from
 * flowModel's answer. No hooks and no DOM, so it renders on the server with
 * the rest of the page and is tested as markup. Motion is CSS alone: each dot
 * rides its route with `offset-path`, started as far along as its age, so the
 * picture keeps moving between refreshes without another request. Under
 * prefers-reduced-motion the dots sit still where their age puts them.
 *
 * Geometry is in SVG user units, and the picture never draws narrower than
 * its design width (W, at 1px a unit): below that the card scrolls sideways,
 * so a phone reads the status text at its designed size instead of a
 * shrunken picture. Dots step once a second rather than every frame - at
 * about a unit a second they look the same - and carry no filter, so twenty
 * five lanes of traffic stay a light load for the browser.
 */

const W = 960;
const HEADER = 22;
const LANE_H = 50;
const RIG_R = 8;
const SHARED_R = 14;
const X = {
  iracing: 100,
  agent: 230,
  network: 360,
  server: 560,
  database: 680,
  feed: 800,
  board: 915,
} as const;
const COLUMNS: Array<[keyof typeof X, string]> = [
  ["iracing", "iRacing"],
  ["agent", "Rig agent"],
  ["network", "Network"],
  ["server", "Server"],
  ["database", "Database"],
  ["feed", "Feed"],
  ["board", "TV board"],
];
/** Characters of a reason that fit under a lane before the shared column. */
const LANE_REASON_CHARS = 74;
const SHARED_REASON_CHARS = 62;
const LINE_H = 13;
/**
 * A dot's label baseline, above the dot: high enough that its glyphs clear a
 * rig node's ring when the dot passes one, and low enough to stay below the
 * reason line of the lane above.
 */
const LABEL_Y = -13;

const WINDOW_S = TRAFFIC_WINDOW_MS / 1000;

/**
 * A lane's data-quality marks (flow.ts Place), drawn under its label: laps
 * that arrived and were stored but will not rank, or rank pending review.
 */
const MARK_LABEL: Record<Mark, string> = { feed: "◆ won't rank", review: "◆ review lap" };

const STYLE = `
.flow-edge { fill: none; stroke-width: 2; stroke-linecap: round; }
.flow-edge[data-state="green"] { stroke: var(--valid); stroke-opacity: 0.4; }
.flow-edge[data-state="yellow"] { stroke: var(--gold); }
.flow-edge[data-state="red"] { stroke: var(--invalid); }
.flow-edge[data-state="grey"], .flow-edge[data-dimmed] { stroke: var(--edge); stroke-opacity: 1; stroke-dasharray: 3 5; }
.flow-edge[data-broken] { stroke-width: 5; stroke-dasharray: none; filter: drop-shadow(0 0 4px currentColor); animation: flow-pulse 1.2s ease-in-out infinite alternate; }
.flow-edge[data-broken][data-state="red"] { color: var(--invalid); }
.flow-edge[data-broken][data-state="yellow"] { color: var(--gold); }
.flow-node { stroke-width: 2.5; fill: var(--surface); }
.flow-node[data-state="green"] { stroke: var(--valid); fill: color-mix(in srgb, var(--valid) 22%, var(--surface)); }
.flow-node[data-state="yellow"] { stroke: var(--gold); fill: color-mix(in srgb, var(--gold) 22%, var(--surface)); }
.flow-node[data-state="red"] { stroke: var(--invalid); fill: color-mix(in srgb, var(--invalid) 30%, var(--surface)); }
.flow-node[data-state="grey"], .flow-node[data-dimmed] { stroke: var(--edge); fill: var(--surface); }
.flow-node[data-dimmed] { opacity: 0.5; }
.flow-reason[data-state="red"] { fill: var(--invalid); }
.flow-reason[data-state="yellow"], .flow-mark[data-state="yellow"] { fill: var(--gold); }
.flow-mark[data-state="red"] { fill: var(--invalid); }
.flow-dot, .flow-held { offset-rotate: 0deg; color: var(--accent); }
.flow-dot circle, .flow-held circle { fill: currentColor; }
.flow-dot text, .flow-held text { fill: currentColor; font-size: 10px; text-anchor: middle; font-family: var(--font-geist-mono), monospace; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round; paint-order: stroke; }
.flow-dot[data-goodbye] circle { fill: none; stroke: currentColor; stroke-width: 1.5; }
[data-status="accepted"] { color: var(--valid); }
[data-status="invalid"] { color: var(--sunset); }
[data-status="unattributed"] { color: var(--purple); }
[data-status="queued"] { color: var(--gold); }
[data-status="refused"] { color: var(--invalid); }
.flow-dot { animation: flow-travel ${WINDOW_S}s steps(${WINDOW_S}) both; }
@keyframes flow-travel { from { offset-distance: 0%; } to { offset-distance: 100%; } }
@keyframes flow-pulse { from { stroke-opacity: 1; } to { stroke-opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) {
  .flow-dot { animation: none; offset-distance: var(--at); }
  .flow-edge[data-broken] { animation: none; }
}
`;

export function RigFlow({ model }: { model: FlowModel }) {
  const lanes = model.lanes;
  const laneY = (i: number) => HEADER + 18 + i * LANE_H;
  const sharedY = lanes.length > 0 ? (laneY(0) + laneY(lanes.length - 1)) / 2 : laneY(0);
  const { shared } = model;
  const sharedBreak = shared.broken === null ? null : shared.edges[shared.broken - 4]!;
  const sharedReason = sharedBreak?.reason ? wrap(sharedBreak.reason, SHARED_REASON_CHARS) : [];
  const height =
    Math.max(
      laneY(Math.max(lanes.length, 1) - 1) + 24,
      sharedY + SHARED_R + 18 + sharedReason.length * LINE_H,
    ) + 4;

  const sharedEdges: Array<[FlowPart, 4 | 5 | 6, string]> = [
    [shared.edges[0], 4, `M ${X.server} ${sharedY} L ${X.database} ${sharedY}`],
    [shared.edges[1], 5, `M ${X.database} ${sharedY} L ${X.feed} ${sharedY}`],
    [shared.edges[2], 6, `M ${X.feed} ${sharedY} L ${X.board} ${sharedY}`],
  ];

  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      className="w-full min-w-[60rem] h-auto font-sans"
      role="img"
      aria-label="Data flow from each rig's iRacing to the TV board"
    >
      <style>{STYLE}</style>
      {COLUMNS.map(([key, label]) => (
        <text
          key={key}
          x={X[key]}
          y={12}
          textAnchor="middle"
          className="fill-muted text-[12px] font-bold tracking-wide"
        >
          {label}
        </text>
      ))}

      {lanes.map((lane, i) => (
        <Lane key={lane.rigId} lane={lane} y={laneY(i)} sharedY={sharedY} />
      ))}
      {sharedEdges.map(([edge, n, d]) => (
        <EdgePath key={n} part={edge} d={d} broken={shared.broken === n} />
      ))}
      {(["server", "database", "feed", "board"] as const).map((node) => (
        <NodeCircle key={node} part={shared.nodes[node]} cx={X[node]} cy={sharedY} r={SHARED_R} />
      ))}
      {/* Traffic over every line and node. Keyed by the render's clock: a
          refresh restarts every dot from its new age. */}
      <g key={model.now}>
        {lanes.map((lane, i) =>
          lane.traffic.map((t) => (
            <Dot key={`${lane.rigId}:${t.kind}:${t.id}`} traveller={t} y={laneY(i)} sharedY={sharedY} />
          )),
        )}
      </g>
      {lanes.map((lane, i) =>
        lane.held.map((h) => (
          <Held key={`${lane.rigId}:${h.status}`} held={h} y={laneY(i)} sharedY={sharedY} />
        )),
      )}
      {sharedReason.length > 0 && (
        <text
          className="flow-reason text-[11px]"
          data-state={sharedBreak!.state}
          x={X.server - SHARED_R}
          y={sharedY + SHARED_R + 16}
        >
          {sharedReason.map((line, i) => (
            <tspan key={i} x={X.server - SHARED_R} dy={i === 0 ? 0 : LINE_H}>
              {line}
            </tspan>
          ))}
        </text>
      )}
    </svg>
  );
}

function Lane({ lane, y, sharedY }: { lane: FlowLane; y: number; sharedY: number }) {
  const segments = [
    `M ${X.iracing} ${y} L ${X.agent} ${y}`,
    `M ${X.agent} ${y} L ${X.network} ${y}`,
    edge3(y, sharedY),
  ];
  const brokenPart = lane.broken === null ? null : lane.edges[lane.broken - 1]!;
  // The line under the lane: the break, or with none, its first mark.
  const note = brokenPart?.reason
    ? { state: brokenPart.state, reason: brokenPart.reason }
    : (lane.marks[0] ?? null);

  return (
    <g data-rig={lane.label}>
      <text x={16} y={y + 4} className="fill-ink text-[13px] font-black">
        {lane.label}
      </text>
      {lane.edges.map((edge, i) => (
        <EdgePath key={i} part={edge} d={segments[i]!} broken={lane.broken === i + 1} />
      ))}
      {(["iracing", "agent", "network"] as const).map((node) => (
        <NodeCircle key={node} part={lane.nodes[node]} cx={X[node]} cy={y} r={RIG_R} />
      ))}
      {lane.marks.map((m, i) => (
        <text
          key={m.mark}
          className="flow-mark text-[10px] font-bold"
          data-mark={m.mark}
          data-state={m.state}
          x={16}
          y={y + 17 + i * 11}
        >
          {MARK_LABEL[m.mark]}
          <title>{m.reason}</title>
        </text>
      ))}
      {note && (
        <text className="flow-reason text-[11px]" data-state={note.state} x={X.iracing - RIG_R} y={y + 21}>
          {truncate(note.reason, LANE_REASON_CHARS)}
          <title>{note.reason}</title>
        </text>
      )}
    </g>
  );
}

function Dot({ traveller: t, y, sharedY }: { traveller: Traveller; y: number; sharedY: number }) {
  const at = Math.min(1, t.ageMs / TRAFFIC_WINDOW_MS);
  const route =
    t.kind === "heartbeat"
      ? `M ${X.agent} ${y} L ${X.network} ${y}${tail(edge3(y, sharedY))}`
      : `M ${X.iracing} ${y} L ${X.agent} ${y} L ${X.network} ${y}${tail(edge3(y, sharedY))}` +
        ` L ${X.database} ${sharedY}` +
        (t.status === "accepted" ? ` L ${X.feed} ${sharedY}` : "");
  const style = {
    offsetPath: `path("${route}")`,
    animationDelay: `${-t.ageMs / 1000}s`,
    "--at": `${(at * 100).toFixed(2)}%`,
  } as CSSProperties;

  if (t.kind === "heartbeat") {
    return (
      <g className="flow-dot" data-kind="heartbeat" data-goodbye={t.goodbye || undefined} style={style}>
        <circle r={2.5} />
      </g>
    );
  }
  // Only a lap on its rig's own straight lane is labelled: on the curves
  // into the server, and on the shared line past it, every rig's lap times
  // would print over each other and over the converging edges.
  const length =
    X.network - X.iracing +
    curveLength(y, sharedY) +
    (X.database - X.server) +
    (t.status === "accepted" ? X.feed - X.database : 0);
  const labelled = at * length <= X.network - X.iracing;
  return (
    <g className="flow-dot" data-kind="lap" data-status={t.status} style={style}>
      <circle r={4.5} />
      {labelled && <text y={LABEL_Y}>{formatLapTime(t.lapTimeMs)}</text>}
    </g>
  );
}

/** Laps that are not moving: queued on the rig, or refused just short of the server. */
function Held({ held, y, sharedY }: { held: HeldLaps; y: number; sharedY: number }) {
  const [cx, cy] = held.status === "queued" ? [X.agent + 26, y] : bezier(y, sharedY, 0.8);
  return (
    <g className="flow-held" data-status={held.status} transform={`translate(${cx} ${cy})`}>
      <circle r={4.5} />
      <text y={LABEL_Y}>
        {held.count} {held.status}
      </text>
    </g>
  );
}

function EdgePath({ part, d, broken }: { part: FlowPart; d: string; broken: boolean }) {
  return (
    <path
      className="flow-edge"
      d={d}
      data-state={part.state}
      data-dimmed={part.dimmed || undefined}
      data-broken={broken || undefined}
    >
      {part.reason && <title>{part.reason}</title>}
    </path>
  );
}

function NodeCircle({ part, cx, cy, r }: { part: FlowPart; cx: number; cy: number; r: number }) {
  return (
    <circle
      className="flow-node"
      cx={cx}
      cy={cy}
      r={r}
      data-state={part.state}
      data-dimmed={part.dimmed || undefined}
    >
      {part.reason && <title>{part.reason}</title>}
    </circle>
  );
}

/** Edge 3: from a rig's network node, curving into the one shared server. */
function edge3(y: number, sharedY: number): string {
  const [c1, c2] = controls(y, sharedY);
  return `M ${X.network} ${y} C ${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${X.server} ${sharedY}`;
}

function controls(y: number, sharedY: number): [[number, number], [number, number]] {
  return [
    [X.network + 90, y],
    [X.server - 110, sharedY],
  ];
}

/** A point on edge 3, `t` of the way along its curve. */
function bezier(y: number, sharedY: number, t: number): [number, number] {
  const [c1, c2] = controls(y, sharedY);
  const p = (a: number, b: number, c: number, d: number) =>
    (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d;
  return [p(X.network, c1[0], c2[0], X.server), p(y, c1[1], c2[1], sharedY)];
}

function curveLength(y: number, sharedY: number): number {
  let length = 0;
  let [px, py] = bezier(y, sharedY, 0);
  for (let i = 1; i <= 16; i++) {
    const [x, yy] = bezier(y, sharedY, i / 16);
    length += Math.hypot(x - px, yy - py);
    [px, py] = [x, yy];
  }
  return length;
}

/** A segment's path without its opening move, to continue a route. */
function tail(segment: string): string {
  return segment.replace(/^M [^A-Z]+/, " ");
}

function truncate(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, chars - 1).trimEnd()}…`;
}

function wrap(text: string, chars: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > chars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
