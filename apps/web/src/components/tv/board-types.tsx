"use client";

import { useEffect, useRef, useState } from "react";
import { formatLapTime } from "@/lib/time";
import {
  type Board,
  type BoardRow,
  trackKey,
} from "@/lib/leaderboards";
import {
  isOpenTonight,
  roundLabel,
  type LeagueRound,
  type RoundResult,
} from "@/lib/league";
import type { SeasonStanding } from "@/lib/league-scoring";
import { useLiveRace } from "@/components/use-live-race";
import { reportingFeedHealth } from "@/lib/tv-feed-health";
import {
  type AnyTvBoardDefinition,
  type TvBoardProps,
  type TvMode,
  type TvSlide,
  defineTvBoard,
} from "@/lib/tv-rotation";
import { ArcadeHighScores, SLOT_COUNT, type ArcadeEntry } from "./arcade-board";
import { RaceOrder } from "./race-board";

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

/**
 * Both feeds rank a driver's fastest lap in a car, so both map the same way.
 * Only the tonight feed says how many incidents the shown lap had; a lap with
 * any is marked. A count the feed does not carry, or does not know (null), is
 * not marked.
 */
const toEntry = (row: {
  driver_id: string;
  display_name: string;
  lap_time_ms: number;
  car_name: string;
  incident_delta?: number | null;
}): ArcadeEntry => ({
  id: row.driver_id,
  name: row.display_name,
  detail: row.car_name,
  timeMs: row.lap_time_ms,
  asterisk: hadOffTrack(row),
});

/**
 * The asterisk on a time. Any iRacing incident counts, not only an off-track,
 * and there is no legend on screen - the owner wanted the mark alone. Only
 * valid laps reach the feed, and validity is judged once at ingestion against
 * the featured combo's `incident_limit` of that moment, so this is true only
 * for a lap whose combo admitted incidents when it arrived - the staff panel
 * writes 0 by default, so on an ordinary day nothing is marked.
 */
const hadOffTrack = (row: { incident_delta?: number | null }) => (row.incident_delta ?? 0) > 0;

/** Counted by `listBoards()` over the whole board, not by the rows on screen -
 *  the board feed is capped at a page of rows and would freeze the number there. */
const driverCount = (n: number) => `${n} driver${n === 1 ? "" : "s"}`;

// ---- tonight board: the featured combo ------------------------------------

/**
 * The tonight board plays two ways. In the rotation it is the top ten of the
 * featured combo, one slide among the others. With `everyone` it is the event
 * view of `/tv`: the same board and the same feed, asking for every driver with
 * a lap today (`limit=all` - no ceiling, so nobody drops off the end
 * unannounced) and scrolling through them, because at an off-site event the
 * point is that everybody finds their own name.
 */
type TonightSpec = { everyone: boolean };

type TonightRow = {
  driver_id: string;
  display_name: string;
  lap_time_ms: number;
  car_name: string;
  /** Incidents on this exact lap; null when the rig did not report a count. */
  incident_delta: number | null;
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

const TONIGHT_BOARD = defineTvBoard<TonightSpec, TonightData>({
  kind: "tonight",
  async load(spec, signal) {
    // The rotation's slide asks for nothing, so the request the venue's wall
    // has always made is unchanged; only the event view asks for everyone.
    const url = spec.everyone ? "/api/leaderboard/tonight?limit=all" : "/api/leaderboard/tonight";
    const data = (await fetchJson(url, signal)) as TonightData;
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

function TonightBoard({ spec, data, stale, hold }: TvBoardProps<TonightSpec, TonightData>) {
  const celebration = usePersonalBest(data.rows, hold);
  const { combo } = data;

  return (
    <>
      <ArcadeHighScores
        eyebrow={spec.everyone ? "Event leaderboard" : "Fastest tonight"}
        title={combo?.track_name ?? "Tonight's fastest"}
        subtitle={[
          ...(combo ? [combo.track_config, combo.car_name] : ["Every combo driven today"]),
          // Counted on the rows rather than in SQL: the event view holds every
          // driver, so here the two are the same number.
          spec.everyone ? driverCount(data.rows.length) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        entries={(spec.everyone ? data.rows : data.rows.slice(0, SLOT_COUNT)).map(toEntry)}
        layout={spec.everyone ? "scroll" : "slots"}
        stale={stale}
      />
      {celebration && (
        <div className="bg-bg/97 fixed inset-0 z-50 flex flex-col items-center justify-center gap-[2em] text-center backdrop-blur-md">
          <p className="font-display text-accent text-glow text-[3em]/[1.2] font-black uppercase tracking-[0.3em]">
            New personal best
          </p>
          <p className="font-display gradient-text max-w-full truncate text-[8em]/[1.1] font-black">
            {celebration.displayName}
          </p>
          <p className="laptime text-valid text-glow-subtle text-[9em]/[1] font-black">
            {formatLapTime(celebration.lapTimeMs)}
          </p>
          <p className="text-muted text-[3em]/[1.2]">
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
  /**
   * Tonight's qualifying: the open round's field ranked by fastest valid lap,
   * from the same round endpoint `/league/[roundId]` reads. Null on every
   * other day, when the board shows the season standings.
   */
  qualifying: { round: LeagueRound; field: RoundResult[] } | null;
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

const LEAGUE_BOARD = defineTvBoard<null, LeagueData>({
  kind: "league",
  async load(_spec, signal) {
    const data = (await fetchJson("/api/league/season", signal)) as Omit<LeagueData, "qualifying">;
    if (!Array.isArray(data.rounds) || !Array.isArray(data.standings)) {
      throw new Error("malformed league response");
    }
    // Only the round that owns the wall tonight is qualifying; the field is
    // read from the round endpoint so the wall ranks exactly what the phone's
    // round page ranks.
    const tonightsRound = data.rounds.find(isOpenTonight) ?? null;
    let qualifying: LeagueData["qualifying"] = null;
    if (tonightsRound) {
      const round = (await fetchJson(`/api/league/rounds/${tonightsRound.id}`, signal)) as {
        field?: unknown;
      };
      if (!Array.isArray(round.field)) throw new Error("malformed round response");
      qualifying = { round: tonightsRound, field: round.field as RoundResult[] };
    }
    return {
      season: data.season ?? null,
      rounds: data.rounds,
      standings: data.standings,
      qualifying,
    };
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
 * League night on the wall, in three screens, all drawn by this one board so
 * the rotation engine still sees one slide that holds. A second holding board
 * cannot work: the engine's hold is a max over the slide on screen, so a
 * separate race slide would never be reached while this one holds.
 *
 *  - Season standings, an arcade table of points, on every ordinary day: one
 *    slide among the others.
 *  - Qualifying, while tonight's round is open: the round's field ranked by
 *    fastest valid lap, the same ranking as `/league/[roundId]`, labelled as
 *    qualifying. This is the screen that takes the wall over.
 *  - The race, while tonight's round is open and the live feed reports a Race
 *    session with a field (`useLiveRace`): the running order in place of the
 *    ranking, refreshed on the feed's own cadence, and after the chequered
 *    flag the finishing order held for a minute before the board goes back to
 *    qualifying. Any other race at the venue is not league night and never
 *    reaches the wall; with no round open the feed is not even asked.
 *
 * League night takes the wall over rather than taking a turn on it: while
 * tonight's round is open, this board renews the
 * rotation's own `hold` on every refresh, so it stays up and keeps updating
 * instead of cycling back to the arcade boards every fifteen seconds. That is
 * the whole takeover, expressed through the board contract - the rotation
 * engine is untouched.
 *
 * The hold lapses on its own, and the arcade rotation resumes, when the round
 * closes, when the feed stops refreshing this board, and at venue midnight - so
 * a night nobody closed out stops owning the wall the next morning, and a race
 * cannot hold it on any other day. Only the display lapses: the
 * round stays open until staff close it, exactly as `rollLeagueSeason`
 * expects. The rest of the week this is one slide among the others.
 *
 * Points are NOT a lap time, so the standings go through `score`/`gap` rather
 * than the lap-time formatter, and the columns are renamed to match.
 */
function LeagueBoard({ data, stale, hold }: TvBoardProps<null, LeagueData>) {
  const tonightsRound = data.rounds.find(isOpenTonight) ?? null;
  const live = useLiveRace(tonightsRound !== null);

  useEffect(() => {
    // Read off `data` rather than a memo so that every refresh - each one a
    // fresh payload - re-tests the venue day and renews the hold.
    if (data.rounds.some(isOpenTonight)) hold(LEAGUE_TAKEOVER_MS);
  }, [data, hold]);

  const title = data.season?.league_name ?? "Oasis League";

  if (tonightsRound && live.race?.session) {
    return (
      // The owner's header for the race (2026-10-01): the eyebrow says only
      // which half of the night this is, and the line under the title names
      // the track alone - no round number, no session state, no layout, no
      // car, no car count, no time or laps left. The room knows the combo,
      // and the running order says how many cars there are.
      <RaceOrder
        eyebrow="Race"
        title={title}
        subtitle={tonightsRound.track_name}
        race={live.race}
        finished={live.finished}
        moves={live.moves}
        stale={stale || live.stale}
      />
    );
  }

  if (data.qualifying && tonightsRound) {
    const { field } = data.qualifying;
    return (
      // The same line under the title as the race screen (the owner, 2026-10-02):
      // the track alone - no layout, no car, no driver count.
      <ArcadeHighScores
        eyebrow={`${roundLabel(tonightsRound)} · Qualifying · live`}
        title={title}
        subtitle={tonightsRound.track_name}
        entries={field.slice(0, SLOT_COUNT).map(toQualifyingEntry)}
        columns={{ detail: "Laps", score: "Best lap" }}
        stale={stale}
      />
    );
  }

  const leader = data.standings[0];
  return (
    <ArcadeHighScores
      eyebrow="Season standings"
      title={title}
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
      // An unclaimed slot here has no points, not an undriven lap time.
      emptyScore="—"
      stale={stale}
    />
  );
}

/**
 * A qualifying row: the driver's best valid lap tonight, and how many laps it
 * took. The table works the gap to the leader out from the time. A driver in
 * the field with no valid lap yet has no time to show and ranks last, which
 * the round feed already does; their score cell reads as the unset time.
 */
const toQualifyingEntry = (row: RoundResult): ArcadeEntry => ({
  id: row.driver_id,
  name: row.display_name,
  detail: `${row.lap_count} ${row.lap_count === 1 ? "lap" : "laps"}`,
  timeMs: row.best_lap_ms ?? undefined,
});

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

/**
 * Every board type `/tv` can play, keyed by `kind`. Each one's loads are
 * counted for the page's heartbeat (`lib/tv-feed-health.ts`), which is how the
 * rig monitor hears that a board is up but cannot load its numbers.
 */
export const TV_BOARD_TYPES: Record<string, AnyTvBoardDefinition> = Object.fromEntries(
  [LEAGUE_BOARD, TRACK_BOARD, TONIGHT_BOARD].map((board) => [board.kind, reportingFeedHealth(board)]),
);

/**
 * The rotation lists, one per `TvMode`.
 *
 * The venue's rotation: the league standings, then tonight's featured combo,
 * then every track with laps on it, in the order `listBoards()` returns them
 * (track name, then layout).
 *
 * League goes first so that on a Wednesday the wall reaches the board that
 * holds it straight away rather than cycling the arcade boards first; on every
 * other day it is an ordinary slide, and it drops out entirely until the venue
 * has run a league round.
 *
 * Slides whose data fails to load or comes back empty are skipped at play time
 * by the engine, so this list can name a board optimistically - the tonight
 * slide simply drops out on a day nobody has driven yet.
 *
 * The event view is one slide: the tonight board with everyone on it. Nothing
 * else is listed, so the engine has nothing to cycle to and keeps refreshing
 * that board - which is the whole difference between the two modes. At an
 * off-site event the tonight board and the all-time board are the same laps
 * under two headings, and a league slide with no season is a counter in the
 * footer that never plays; the owner saw "three displays" of one event.
 */
export function buildRotation(boards: Board[], mode: TvMode = "rotation"): TvSlide[] {
  if (mode === "event") {
    return [{ key: "event", kind: "tonight", spec: { everyone: true } satisfies TonightSpec }];
  }
  return [
    { key: "league", kind: "league", spec: null },
    { key: "tonight", kind: "tonight", spec: { everyone: false } satisfies TonightSpec },
    ...boards.map((board) => ({
      key: `track:${trackKey(board)}`,
      kind: "track",
      spec: board,
    })),
  ];
}
