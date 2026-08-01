"use client";

import { useEffect, useRef, useState } from "react";
import { formatLapTime } from "@/lib/time";
import { type Board, type BoardRow, trackKey, trackLabel } from "@/lib/leaderboards";
import {
  type AnyTvBoardDefinition,
  type TvBoardProps,
  type TvSlide,
  defineTvBoard,
} from "@/lib/tv-rotation";
import { ArcadeHighScores, SLOT_COUNT, type ArcadeEntry } from "./arcade-board";

/**
 * The board types `/tv` knows how to play, and the order it plays them in.
 *
 * This file is the seam described in `lib/tv-rotation.ts`: adding a board type
 * (league standings, rig status, an event countdown) means adding one
 * `defineTvBoard` below, listing it in `TV_BOARD_TYPES`, and emitting its slides
 * from `buildRotation`. The rotation engine in `tv-screen.tsx` needs no change -
 * it only ever talks to a board through the `TvBoardDefinition` contract.
 *
 * Neither loader reimplements ranking: both call the same public APIs the
 * `/leaderboards` browser uses, so the wall and the phone agree by construction.
 */

// ---- track board: one track layout, all-time ------------------------------

/** All-time is the right window for a high-score table: the wall celebrates the
 *  shop record, not who happened to be in tonight. `/leaderboards` also defaults
 *  to all-time, so the two match for the same combo. */
type TrackSpec = Board;

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { cache: "no-store", signal });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

const TRACK_BOARD = defineTvBoard<TrackSpec, BoardRow[]>({
  kind: "track",
  async load(spec, signal) {
    const params = new URLSearchParams({ track: spec.track_name, window: "alltime" });
    if (spec.track_config) params.set("config", spec.track_config);
    const data = await fetchJson(`/api/leaderboards/board?${params}`, signal);
    const rows = (data as { rows?: unknown }).rows;
    if (!Array.isArray(rows)) throw new Error("malformed board response");
    return rows as BoardRow[];
  },
  hasContent: (rows) => rows.length > 0,
  Board({ spec, data, stale }) {
    return (
      <ArcadeHighScores
        eyebrow="All-time best laps"
        title={spec.track_name}
        subtitle={[spec.track_config, driverCount(data.length)]
          .filter(Boolean)
          .join(" · ")}
        entries={data.slice(0, SLOT_COUNT).map(toEntry)}
        stale={stale}
      />
    );
  },
});

/** Both feeds rank a driver's fastest lap in a car, so both map the same way. */
const toEntry = (row: {
  driver_id: string;
  display_name: string;
  lap_time_ms: number;
  car_name: string;
}): ArcadeEntry => ({
  id: row.driver_id,
  name: row.display_name,
  detail: row.car_name,
  timeMs: row.lap_time_ms,
});

const driverCount = (n: number) => `${n} driver${n === 1 ? "" : "s"}`;

// ---- tonight board: the featured combo ------------------------------------

type TonightRow = {
  driver_id: string;
  display_name: string;
  lap_time_ms: number;
  car_name: string;
};

type TonightData = {
  rows: TonightRow[];
  combo: { track_name: string; track_config: string | null; car_name: string } | null;
};

/** How long a personal-best celebration owns the screen. */
const CELEBRATION_MS = 7_000;

const TONIGHT_BOARD = defineTvBoard<null, TonightData>({
  kind: "tonight",
  async load(_spec, signal) {
    const data = (await fetchJson("/api/leaderboard/tonight", signal)) as TonightData;
    if (!Array.isArray(data.rows)) throw new Error("malformed tonight response");
    return { rows: data.rows, combo: data.combo ?? null };
  },
  // No laps tonight is the normal state on a quiet afternoon - skip the slide
  // rather than putting an empty board on the wall.
  hasContent: (data) => data.rows.length > 0,
  Board: TonightBoard,
});

function TonightBoard({ data, stale, hold }: TvBoardProps<null, TonightData>) {
  const celebration = usePersonalBest(data.rows, hold);
  const { combo } = data;

  return (
    <>
      <ArcadeHighScores
        eyebrow="Fastest tonight"
        title={combo?.track_name ?? "Tonight's fastest"}
        subtitle={
          combo
            ? [combo.track_config, combo.car_name].filter(Boolean).join(" · ")
            : "Every combo driven today"
        }
        entries={data.rows.slice(0, SLOT_COUNT).map(toEntry)}
        stale={stale}
      />
      {celebration && (
        <div className="bg-bg/97 fixed inset-0 z-50 flex flex-col items-center justify-center gap-8 text-center backdrop-blur-md">
          <p className="font-display text-accent text-glow text-5xl font-black uppercase tracking-[0.3em]">
            New personal best
          </p>
          <p className="font-display gradient-text text-9xl font-black">
            {celebration.displayName}
          </p>
          <p className="laptime text-valid text-glow-subtle text-[9rem] font-black leading-none">
            {formatLapTime(celebration.lapTimeMs)}
          </p>
          <p className="text-muted text-5xl">
            −{(celebration.improvementMs / 1000).toFixed(3)} · now P{celebration.rank}
          </p>
        </div>
      )}
    </>
  );
}

type Celebration = {
  displayName: string;
  lapTimeMs: number;
  improvementMs: number;
  rank: number;
};

/**
 * Fires a full-screen celebration when a driver's best tonight improves between
 * two refreshes, and asks the rotation to hold the board while it plays so the
 * moment isn't cut off mid-cheer.
 */
function usePersonalBest(rows: TonightRow[], hold: (ms: number) => void) {
  const [celebration, setCelebration] = useState<Celebration | null>(null);
  const previousBests = useRef<Map<string, number>>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const previous = previousBests.current;
    // The first load is a baseline, not an improvement.
    if (previous.size > 0) {
      for (const [index, row] of rows.entries()) {
        const before = previous.get(row.driver_id);
        if (before !== undefined && row.lap_time_ms < before) {
          setCelebration({
            displayName: row.display_name,
            lapTimeMs: row.lap_time_ms,
            improvementMs: before - row.lap_time_ms,
            rank: index + 1,
          });
          hold(CELEBRATION_MS);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCelebration(null), CELEBRATION_MS);
          break;
        }
      }
    }
    previousBests.current = new Map(rows.map((r) => [r.driver_id, r.lap_time_ms]));
  }, [rows, hold]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return celebration;
}

// ---- registry + rotation list ---------------------------------------------

/** Every board type `/tv` can play, keyed by `kind`. */
export const TV_BOARD_TYPES: Record<string, AnyTvBoardDefinition> = {
  [TRACK_BOARD.kind]: TRACK_BOARD,
  [TONIGHT_BOARD.kind]: TONIGHT_BOARD,
};

/**
 * The rotation: tonight's featured combo first, then every track with laps on
 * it, in the order `listBoards()` returns them (track name, then layout).
 *
 * Slides whose data fails to load or comes back empty are skipped at play time
 * by the engine, so this list can name a board optimistically - the tonight
 * slide simply drops out on a day nobody has driven yet.
 */
export function buildRotation(boards: Board[]): TvSlide[] {
  return [
    { key: "tonight", kind: "tonight", spec: null },
    ...boards.map((board) => ({
      key: `track:${trackKey(board)}`,
      kind: "track",
      spec: board,
    })),
  ];
}

/** Label for a slide, used by the rotation footer's "up next". */
export function slideLabel(slide: TvSlide): string {
  if (slide.kind === "track") return trackLabel(slide.spec as Board);
  return "Fastest tonight";
}
