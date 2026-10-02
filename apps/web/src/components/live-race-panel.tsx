"use client";

import { formatLapTime } from "@/lib/time";
import type { LiveRaceRow } from "@/lib/race-live";
import {
  formatRaceGap,
  remainingLabel,
  rowName,
  sessionStateLabel,
  type RaceMove,
} from "@/lib/race-board";
import { useLiveRace, type LiveRaceView } from "@/components/use-live-race";

/**
 * The live race on `/league`: the same feed, the same rules and the same
 * minute under the flag as the wall's race screen (`lib/race-board.ts`,
 * `useLiveRace`), drawn for a phone held in the paddock. Renders nothing at
 * all while no race is on - the standings page is unchanged on an ordinary
 * day - and sits above the standings while one is.
 *
 * Phone-first: three columns at 390px (place, driver with laps and last lap
 * under the name, gap with the interval under it), so nothing needs a
 * horizontal scroll. A rig nobody is signed in on reads as "Rig N" in the
 * muted colour, a silent rig is dimmed where it was, a car on pit road
 * carries a PIT chip, and a row that just changed place flashes and shows
 * ▲n / ▼n for a few seconds, exactly as on the wall.
 */
export function LiveRacePanel() {
  const live = useLiveRace(true);
  if (!live.race?.session) return null;
  return <LiveRaceTable live={live} />;
}

/** The panel's markup, over a view the hook produced; separate so it renders without the feed. */
export function LiveRaceTable({ live }: { live: LiveRaceView }) {
  if (!live.race?.session) return null;
  const { session, rows } = live.race;
  const remaining = remainingLabel(session);

  return (
    <section
      aria-label="Live race"
      data-live-race
      className={`mb-[clamp(0.5rem,0.8vw,1rem)] flex flex-col gap-2 transition-opacity ${
        live.stale ? "opacity-70" : ""
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-[clamp(0.6rem,1vw,1.4rem)]">
        <h2 className="font-display flex items-center gap-2 text-accent text-glow-subtle font-bold uppercase tracking-[0.2em] text-[clamp(0.75rem,1vw,1.2rem)]">
          {!live.finished && (
            <span className="h-2 w-2 rounded-full bg-valid animate-pulse" aria-hidden />
          )}
          {live.finished ? "Race result" : "Live race"}
        </h2>
        <p className="text-muted text-[clamp(0.7rem,0.9vw,1.05rem)]">
          {[sessionStateLabel(session.sessionState), remaining, carCount(rows.length)]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      <ol className="flex flex-col gap-[clamp(0.3rem,0.45vw,0.6rem)]">
        {rows.map((row) => (
          <RaceRow
            key={`${row.rigNumber}:${live.moves.get(row.rigNumber)?.seq ?? 0}`}
            row={row}
            move={live.moves.get(row.rigNumber) ?? null}
            winner={live.finished && row.place === 1}
          />
        ))}
      </ol>
    </section>
  );
}

function RaceRow({
  row,
  move,
  winner,
}: {
  row: LiveRaceRow;
  move: RaceMove | null;
  winner: boolean;
}) {
  const unnamed = row.driverName === null;
  const moved = move ? (move.delta > 0 ? "up" : "down") : null;
  const leader = row.place === 1;
  return (
    <li
      data-live-race-row
      data-stale={row.stale ? "" : undefined}
      data-moved={moved ?? undefined}
      className={`grid grid-cols-[clamp(1.6rem,2.2vw,2.6rem)_minmax(0,1fr)_auto] items-center gap-[clamp(0.6rem,1.2vw,1.6rem)] rounded-xl border border-edge bg-surface px-[clamp(0.6rem,1vw,1.4rem)] py-[clamp(0.4rem,0.5vw,0.7rem)] ${
        moved ? `race-row-moved race-row-${moved}` : ""
      } ${row.stale ? "opacity-40" : ""}`}
    >
      <span
        className={`font-display font-black tabular-nums text-[clamp(1.3rem,1.9vw,2.2rem)] ${
          leader ? "text-gold text-glow-subtle" : "text-muted"
        }`}
      >
        {row.place}
      </span>

      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <span
            className={`truncate font-bold text-[clamp(1rem,1.6vw,1.9rem)] leading-tight ${
              unnamed ? "text-muted" : ""
            }`}
          >
            {rowName(row)}
          </span>
          {winner && (
            <span className="shrink-0 text-gold font-bold uppercase tracking-[0.14em] text-[clamp(0.55rem,0.7vw,0.9rem)]">
              winner
            </span>
          )}
          {row.onPitRoad && (
            <span
              data-live-race-pit
              className="shrink-0 rounded border border-sunset px-1 text-sunset font-bold uppercase tracking-[0.14em] text-[clamp(0.55rem,0.7vw,0.9rem)]"
            >
              pit
            </span>
          )}
          {move && (
            <span
              data-live-race-move
              className={`race-move shrink-0 rounded px-1 font-black tabular-nums text-[clamp(0.7rem,0.9vw,1.05rem)] ${
                move.delta > 0 ? "bg-valid/20 text-valid" : "bg-invalid/20 text-invalid"
              }`}
            >
              {move.delta > 0 ? "▲" : "▼"}
              {Math.abs(move.delta)}
            </span>
          )}
        </span>
        <span className="laptime block text-muted text-[clamp(0.65rem,0.78vw,0.9rem)] leading-tight">
          {row.lapsCompleted === null ? "—" : `L${row.lapsCompleted}`}
          {row.lastLapMs !== null && ` · last ${formatLapTime(row.lastLapMs)}`}
          {row.stale && " · no signal"}
        </span>
      </span>

      <span className="text-right">
        <span className="laptime block font-black leading-none text-[clamp(1.1rem,1.6vw,1.9rem)]">
          {leader ? "Leader" : formatRaceGap(row.gapToLeaderS)}
        </span>
        <span className="laptime block text-muted leading-tight text-[clamp(0.6rem,0.72vw,0.85rem)]">
          {leader ? " " : `int ${formatRaceGap(row.intervalS)}`}
        </span>
      </span>
    </li>
  );
}

const carCount = (n: number) => `${n} ${n === 1 ? "car" : "cars"}`;
