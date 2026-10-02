import { formatLapTime } from "@/lib/time";
import type { LiveRace, LiveRaceRow } from "@/lib/race-live";
import { formatRaceGap, rowName, type RaceMove } from "@/lib/race-board";

/**
 * The wall's live race order: one row per car in the race, in the feed's
 * order (`place`), with laps, gap to the leader, interval to the car ahead,
 * last lap and a pit marker. Presentation only - the league board decides
 * when this replaces the standings (`lib/race-board.ts`) and hands it the
 * feed; nothing here loads or ranks.
 *
 * Same sizing discipline as `arcade-board.tsx`: every length is in `em` of
 * `.tv-scale`, the one column whose content varies (driver) is the `fr`
 * track, and rows carry a `min-h` from their own text so they can stretch
 * but never collapse into each other.
 *
 * A league field is twenty cars and more, twice what the arcade table's ten
 * slots hold, so past `SPLIT_AFTER` rows the same composition is drawn as two
 * halves side by side, each at three quarters of the size. That is one
 * layout at two scales, not two layouts: the halves are the same markup with
 * a smaller `font-size`, so every `em` inside them shrinks together.
 *
 * What the room is meant to read at a glance:
 *   - a row that just changed place flashes and carries ▲n / ▼n beside the
 *     name for a few seconds (the hook keys the row on the move, so the
 *     animation restarts on every move);
 *   - a rig that stopped reporting is dimmed where it was;
 *   - a rig with nobody signed in reads as "Rig N" in the muted colour;
 *   - a car on pit road carries a PIT chip.
 */

/** Past this many cars the table is drawn as two halves. */
export const SPLIT_AFTER = 10;

/**
 * Place, driver, laps, gap, interval, last lap, pit. Each fixed track is
 * sized for the widest string it can hold at its own text size: the gap
 * column prints `+10:01.204` at 2.25em, the interval and last lap print the
 * same shape at 1.75em (`formatGap`/`formatLapTime` widen past a minute and
 * past ten minutes alike), a lap count is three digits at most, and the pit
 * chip is three letters.
 */
const COLUMNS =
  "grid grid-cols-[5em_minmax(0,1fr)_4.5em_12.5em_9.5em_9.5em_4.5em] items-center gap-[1.25em]";

/** Floor on a row's height: the place at 2.75em is the tallest thing in it. */
const ROW_MIN_H = "min-h-[3.75em]";

const HEADING = "text-[1.125em] font-bold uppercase tracking-[0.3em]";

const PLACE_STYLES = ["text-gold text-glow-subtle", "text-silver", "text-bronze"] as const;

type Props = {
  eyebrow: string;
  title: string;
  subtitle?: string;
  race: LiveRace;
  /** The flag is out: this is the finishing order, so the leader is the winner. */
  finished: boolean;
  moves: ReadonlyMap<number, RaceMove>;
  /** Last refresh failed; dim slightly so the room reads it as held, not live. */
  stale?: boolean;
};

export function RaceOrder({ eyebrow, title, subtitle, race, finished, moves, stale = false }: Props) {
  const rows = race.rows;
  const split = rows.length > SPLIT_AFTER;
  const halves = split
    ? [rows.slice(0, Math.ceil(rows.length / 2)), rows.slice(Math.ceil(rows.length / 2))]
    : [rows];

  return (
    <section
      data-tv-race
      className={`flex min-h-0 flex-1 flex-col transition-opacity duration-500 ${
        stale ? "opacity-70" : "opacity-100"
      }`}
    >
      <header className="flex shrink-0 flex-col gap-[0.5em]">
        <p className="font-display text-accent text-glow-subtle text-[1.25em]/[1.4] font-bold uppercase tracking-[0.42em]">
          {eyebrow}
        </p>
        <h1 className="font-display gradient-text truncate text-[4.25em]/[1] font-black uppercase tracking-tight">
          {title}
        </h1>
        {subtitle && <p className="text-muted truncate text-[1.875em]/[1.25]">{subtitle}</p>}
      </header>

      <div className="gradient-rule mt-[1.25em] mb-[1em] h-[0.25em] shrink-0 rounded-full" />

      {/* Two halves sit side by side at 0.75em each; one list keeps the base size. */}
      <div
        className={`flex min-h-0 flex-1 ${split ? "gap-[3em] text-[0.75em]" : ""}`}
      >
        {halves.map((half, halfIndex) => (
          <div key={halfIndex} className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className={`text-muted shrink-0 ${COLUMNS}`}>
              <span className={HEADING}>Pos</span>
              <span className={HEADING}>Driver</span>
              <span className={`${HEADING} text-right`}>Laps</span>
              <span className={`${HEADING} text-right`}>Gap</span>
              <span className={`${HEADING} text-right`}>Int</span>
              <span className={`${HEADING} text-right`}>Last</span>
              <span className={HEADING} aria-label="Pit" />
            </div>
            <ol className="mt-[0.25em] flex flex-1 flex-col">
              {half.map((row) => (
                <RaceRow
                  key={`${row.rigNumber}:${moves.get(row.rigNumber)?.seq ?? 0}`}
                  row={row}
                  move={moves.get(row.rigNumber) ?? null}
                  winner={finished && row.place === 1}
                />
              ))}
            </ol>
          </div>
        ))}
      </div>
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
  return (
    <li
      data-tv-race-row
      data-stale={row.stale ? "" : undefined}
      data-moved={moved ?? undefined}
      className={`${COLUMNS} ${ROW_MIN_H} border-edge max-h-[5.5em] flex-1 border-b px-[0.5em] last:border-b-0 ${
        moved ? `race-row-moved race-row-${moved}` : ""
      } ${row.stale ? "opacity-40" : ""}`}
    >
      <span
        className={`font-display text-[2.75em]/[1.1] font-black tabular-nums ${
          PLACE_STYLES[row.place - 1] ?? "text-muted"
        }`}
      >
        {String(row.place).padStart(2, "0")}
      </span>

      <span className="flex min-w-0 items-center gap-[0.75em]">
        <span
          className={`truncate text-[2.5em]/[1.1] font-bold ${unnamed ? "text-muted" : ""}`}
        >
          {rowName(row)}
        </span>
        {winner && (
          <span className="font-display text-gold shrink-0 text-[1.125em] font-bold uppercase tracking-[0.3em]">
            Winner
          </span>
        )}
        {move && (
          <span
            data-tv-race-move
            className={`race-move shrink-0 rounded-[0.25em] px-[0.4em] text-[1.5em]/[1.3] font-black tabular-nums ${
              move.delta > 0 ? "bg-valid/20 text-valid" : "bg-invalid/20 text-invalid"
            }`}
          >
            {move.delta > 0 ? "▲" : "▼"}
            {Math.abs(move.delta)}
          </span>
        )}
      </span>

      <span className="laptime text-right text-[2.25em]/[1.1] font-bold">
        {row.lapsCompleted ?? "—"}
      </span>
      <span className="laptime text-right text-[2.25em]/[1.1] font-bold">
        {row.place === 1 ? "Leader" : formatRaceGap(row.gapToLeaderS)}
      </span>
      <span className="laptime text-muted text-right text-[1.75em]/[1.2]">
        {row.place === 1 ? "—" : formatRaceGap(row.intervalS)}
      </span>
      <span className="laptime text-muted text-right text-[1.75em]/[1.2]">
        {row.lastLapMs === null ? "—" : formatLapTime(row.lastLapMs)}
      </span>
      <span className="flex justify-end">
        {row.onPitRoad && (
          <span
            data-tv-race-pit
            className="font-display border-sunset text-sunset rounded-[0.25em] border px-[0.4em] text-[1.125em]/[1.6] font-bold tracking-[0.2em]"
          >
            PIT
          </span>
        )}
      </span>
    </li>
  );
}
