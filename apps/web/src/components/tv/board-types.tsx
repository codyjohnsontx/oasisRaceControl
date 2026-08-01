"use client";

import { useEffect, useRef, useState } from "react";
import { formatLapTime } from "@/lib/time";
import { type Board, type BoardRow, trackKey } from "@/lib/leaderboards";
import { roundLabel, type LeagueRound } from "@/lib/league";
import type { SeasonStanding } from "@/lib/league-scoring";
import { venueToday } from "@/lib/venue";
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
 * (rig status, an event countdown) means adding one `defineTvBoard` below,
 * listing it in `TV_BOARD_TYPES`, and emitting its slides from `buildRotation`.
 * The rotation engine in `tv-screen.tsx` needs no change - it only ever talks to
 * a board through the `TvBoardDefinition` contract. The league board below was
 * added this way, takeover included.
 *
 * No loader reimplements ranking or scoring: they call the same public APIs
 * `/leaderboards` and `/league` use, so the wall and the phone agree by
 * construction.
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
        subtitle={[spec.track_config, driverCount(spec.driver_count)]
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

/** Counted by `listBoards()` over the whole board, not by the rows on screen -
 *  the board feed is capped at a page of rows and would freeze the number there. */
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

/**
 * Best time seen per driver tonight. Module-level precisely so the baseline
 * survives `TonightBoard` unmounting, which the rotation does every time it
 * moves to another slide: a per-mount baseline would start empty on every pass,
 * so a lap set while a track board was up would read as a first load and never
 * be celebrated.
 */
const previousBests = new Map<string, number>();

const TONIGHT_BOARD = defineTvBoard<null, TonightData>({
  kind: "tonight",
  async load(_spec, signal) {
    const data = (await fetchJson("/api/leaderboard/tonight", signal)) as TonightData;
    if (!Array.isArray(data.rows)) throw new Error("malformed tonight response");
    // An empty feed is the venue day rolling over. This runs on every pass,
    // including the ones where the slide is then skipped as empty, so it is the
    // only place that sees the rollover - drop the baseline here or the first
    // lap of the new day gets celebrated against yesterday's combo.
    if (data.rows.length === 0) previousBests.clear();
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
 * Fires a full-screen celebration when a driver's best tonight improves on the
 * last one seen, and asks the rotation to hold the board while it plays so the
 * moment isn't cut off mid-cheer.
 */
function usePersonalBest(rows: TonightRow[], hold: (ms: number) => void) {
  const [celebration, setCelebration] = useState<Celebration | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // The first load is a baseline, not an improvement.
    if (previousBests.size > 0) {
      for (const [index, row] of rows.entries()) {
        const before = previousBests.get(row.driver_id);
        if (before !== undefined && row.lap_time_ms < before) {
          // The polled tonight feed is the external system this effect syncs
          // with, and announcing an improvement between two of its loads is the
          // whole point of the board. A handful of celebrations an evening is
          // not the cascading-render case the rule is guarding against.
          // eslint-disable-next-line react-hooks/set-state-in-effect
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
    previousBests.clear();
    for (const row of rows) previousBests.set(row.driver_id, row.lap_time_ms);
  }, [rows, hold]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return celebration;
}

// ---- league board: the season standings -----------------------------------

type LeagueData = {
  season: { id: string; name: string; league_name: string } | null;
  rounds: LeagueRound[];
  standings: SeasonStanding[];
};

/**
 * How long the league board asks to keep the wall each time it refreshes, while
 * tonight's round is open. Comfortably longer than the engine's own refresh
 * interval, so each live refresh renews the hold before the last one runs out;
 * short enough that the wall goes back to the arcade rotation within half a
 * minute of staff closing the round, of the venue day rolling over, or of the
 * league feed going quiet.
 */
const LEAGUE_TAKEOVER_MS = 30_000;

/**
 * Whether a round is the one the wall should be showing right now: still open,
 * and belonging to the venue's current day.
 *
 * The venue-day half is what keeps a forgotten round off the wall. Nothing
 * closes a round automatically - `rollLeagueSeason` refuses while one is open
 * precisely because staff are expected to do it - so without this a Wednesday
 * night nobody closed out would still own the TV on Saturday. `round_date` is
 * the venue-local day the round opened (`venue_today()` at insert), compared
 * against the same venue day the rest of the product means by "tonight".
 */
const ownsTheWall = (round: LeagueRound) =>
  round.closed_at === null && round.round_date === venueToday();

const LEAGUE_BOARD = defineTvBoard<null, LeagueData>({
  kind: "league",
  async load(_spec, signal) {
    const data = (await fetchJson("/api/league/season", signal)) as LeagueData;
    if (!Array.isArray(data.rounds) || !Array.isArray(data.standings)) {
      throw new Error("malformed league response");
    }
    return { season: data.season ?? null, rounds: data.rounds, standings: data.standings };
  },
  // Before the venue's first league night there is no season and no round, so
  // the slide is skipped like any other empty board. A season with rounds but
  // no times yet still plays: an arcade table of unclaimed slots is the
  // invitation this display is for, and it is what the wall shows in the hour
  // between staff opening a round and the first lap landing.
  hasContent: (data) => data.season !== null && data.rounds.length > 0,
  Board: LeagueBoard,
});

/**
 * Season standings, drawn as an arcade table. Points are NOT a lap time, so
 * they go through `score`/`gap` rather than the lap-time formatter, and the
 * columns are renamed to match.
 *
 * League night takes the wall over rather than taking a turn on it: while
 * tonight's round is open this board renews the rotation's own `hold` on every
 * refresh, so it stays up and keeps updating instead of cycling back to the
 * arcade boards every fifteen seconds. That is the whole takeover, expressed
 * through the board contract - the rotation engine is untouched.
 *
 * The hold lapses on its own, and the arcade rotation resumes, when the round
 * closes, when the feed stops refreshing this board, and at venue midnight - so
 * a night nobody closed out stops owning the wall the next morning. Only the
 * display lapses: the round stays open until staff close it, exactly as
 * `rollLeagueSeason` expects. The rest of the week this is one slide among the
 * others.
 */
function LeagueBoard({ data, stale, hold }: TvBoardProps<null, LeagueData>) {
  useEffect(() => {
    // Read off `data` rather than a memo so that every refresh - each one a
    // fresh payload - re-tests the venue day and renews the hold.
    if (data.rounds.some(ownsTheWall)) hold(LEAGUE_TAKEOVER_MS);
  }, [data, hold]);

  const tonightsRound = data.rounds.find(ownsTheWall) ?? null;
  const leader = data.standings[0];

  return (
    <ArcadeHighScores
      eyebrow={tonightsRound ? `${roundLabel(tonightsRound)} · live now` : "Season standings"}
      title={data.season?.league_name ?? "Oasis League"}
      subtitle={[data.season?.name, roundCount(data.rounds.length)]
        .filter(Boolean)
        .join(" · ")}
      entries={data.standings.slice(0, SLOT_COUNT).map((standing, index) => ({
        id: standing.driver_id,
        name: standing.display_name,
        detail: seasonRecord(standing),
        score: String(standing.points),
        gap: leagueGap(standing, leader, index),
      }))}
      columns={{ detail: "Record", score: "Points", gap: "Behind" }}
      stale={stale}
    />
  );
}

const roundCount = (n: number) => `${n} round${n === 1 ? "" : "s"}`;

/** What a driver has done this season, in the column a lap board uses for the car. */
const seasonRecord = (standing: SeasonStanding) =>
  [
    `${standing.rounds_entered} ${standing.rounds_entered === 1 ? "round" : "rounds"}`,
    standing.wins > 0 ? `${standing.wins} ${standing.wins === 1 ? "win" : "wins"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

/** Points behind the leader. A driver level on points is behind on the
 *  tiebreak, not by "-0". */
function leagueGap(
  standing: SeasonStanding,
  leader: SeasonStanding | undefined,
  index: number,
): string {
  if (index === 0 || !leader) return "—";
  return leader.points === standing.points ? "level" : `-${leader.points - standing.points}`;
}

// ---- registry + rotation list ---------------------------------------------

/** Every board type `/tv` can play, keyed by `kind`. */
export const TV_BOARD_TYPES: Record<string, AnyTvBoardDefinition> = {
  [LEAGUE_BOARD.kind]: LEAGUE_BOARD,
  [TRACK_BOARD.kind]: TRACK_BOARD,
  [TONIGHT_BOARD.kind]: TONIGHT_BOARD,
};

/**
 * The rotation: the league standings, then tonight's featured combo, then every
 * track with laps on it, in the order `listBoards()` returns them (track name,
 * then layout).
 *
 * League goes first so that on a Wednesday the wall reaches the board that
 * holds it straight away rather than cycling the arcade boards first; on every
 * other day it is an ordinary slide, and it drops out entirely until the venue
 * has run a league round.
 *
 * Slides whose data fails to load or comes back empty are skipped at play time
 * by the engine, so this list can name a board optimistically - the tonight
 * slide simply drops out on a day nobody has driven yet.
 */
export function buildRotation(boards: Board[]): TvSlide[] {
  return [
    { key: "league", kind: "league", spec: null },
    { key: "tonight", kind: "tonight", spec: null },
    ...boards.map((board) => ({
      key: `track:${trackKey(board)}`,
      kind: "track",
      spec: board,
    })),
  ];
}
