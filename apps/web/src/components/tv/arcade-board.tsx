import type { CSSProperties } from "react";
import { formatGap, formatLapTime } from "@/lib/time";
import { AutoScroll } from "./auto-scroll";

/**
 * Shared presentation for `/tv` boards: an arcade high-score table, sized to be
 * read from across the shop. Board types feed it entries; it owns nothing about
 * loading or rotation.
 *
 * Three layouts of the same table. In the rotation (`layout: "slots"`, the
 * default) every board renders the same `SLOT_COUNT` rank slots whether or not
 * they're filled. That's deliberate on two counts: an arcade table with
 * unclaimed slots reads as an invitation rather than as a bug, and a constant
 * row height keeps the layout from jumping as the rotation moves between a
 * busy board and a quiet one. The event view (`layout: "scroll"`) is the
 * opposite job - show everyone - so it draws every entry at the row's own
 * height and lets `AutoScroll` carry the ones below the fold up on their own.
 * League night's qualifying (`layout: "halves"`) must also show everyone but
 * cannot scroll on an unattended wall, so it is the slots table until the
 * field outgrows `SPLIT_AFTER`, and past that every entry, drawn as two halves
 * side by side at three quarters of the size - the race table's split.
 * Header, rule, headings and the row itself are the same markup either way.
 *
 * Sizing: every length here is in `em` of `.tv-scale` (see `globals.css`), so
 * the table is one 1920x1080 composition scaled to whatever panel it lands on
 * rather than a set of pixel sizes that happen to suit one. The two rules that
 * keep it whole on the venue's 1272x601 wall:
 *
 *  - Columns whose content varies - driver and detail - are `fr` tracks, so
 *    they divide whatever the fixed ones leave rather than being handed a
 *    number tuned on a laptop. Only rank and the two monospace score columns
 *    are fixed, because a rank and a lap time genuinely are a fixed number of
 *    characters wide.
 *  - Rows carry a minimum height set by the text in them (`ROW_MIN_H`), so ten
 *    of them can never be compressed into less height than they need to print.
 *    They still stretch to fill a taller screen; they just cannot collapse.
 */

/** Rank slots drawn on every board - filled ones show a driver, the rest sit open. */
export const SLOT_COUNT = 10;

/** Past this many rows a table that shows everyone is drawn as two halves. */
export const SPLIT_AFTER = SLOT_COUNT;

/**
 * The two halves' container: side by side, each at three quarters of the
 * size. One composition at two scales, not two layouts - the halves are the
 * same markup with a smaller `font-size`, so every `em` inside them shrinks
 * together.
 */
export const HALVES = "gap-[3em] text-[0.75em]";

/** A list as the halves it is drawn in: itself up to `SPLIT_AFTER` rows, the
 *  first half taking the odd row past that. */
export function splitHalves<T>(rows: readonly T[]): (readonly T[])[] {
  if (rows.length <= SPLIT_AFTER) return [rows];
  const cut = Math.ceil(rows.length / 2);
  return [rows.slice(0, cut), rows.slice(cut)];
}

/** Cap on a row's height in the halves, so a short half's rows line up with
 *  the long one's instead of stretching to fill. */
export const HALF_ROW_MAX_H = "max-h-[5.5em]";

/**
 * The table's columns, shared by the heading row and every slot so the two stay
 * in step. Rank and the two score columns are fixed because their content is:
 * the board's rank digits (`rankWidth`, sized for Orbitron's widest, not for
 * "01"), a lap time, a gap - all fixed-width by nature, and each sized for the
 * widest string it can realistically hold rather than the common one. Both time
 * columns gain a digit past ten minutes, which a 25km layout reaches on an
 * ordinary slow lap: `formatLapTime` prints `10:18.103` and `formatGap` switches
 * to a lap-time shape past a minute and widens the same way (`+10:01.204`).
 * 14.5em and 9.5em hold those through `59:59.999`.
 *
 * Both are fitted sizes, not invariants. What keeps a lap inside them is the
 * ingestion ceiling, `MAX_LAP_TIME_MS` in `lib/events.ts`, chosen from what a
 * lap can be rather than from these tracks; the guard in `lib/time.test.ts`
 * checks that `formatLapTime(MAX_LAP_TIME_MS)` still fits the `59:59.999`
 * shape, so a raised ceiling fails there before it reaches the wall. Before
 * that bound existed, `lap_time_ms` was only checked as a positive int, and
 * this is what an over-long value did, measured at 1272x601: the spill runs
 * right into the 13.3px gutter before the next column and is absorbed there
 * through ten characters (`123:45.678` spills 4.4px); an eleventh
 * (`1234:56.789`, 17.8px) crosses the gutter and paints over the gap column's
 * text. It never reaches the screen edge, so `main`'s `overflow-hidden` is not
 * what contains this - the bound is.
 *
 * Everything left over goes to driver and detail in a 5:4 split,
 * which is roughly the ratio of their longest real content - a 24-character
 * display name (the cap in `driver-auth.ts`) at `2.5em` against a car name at
 * `1.5em`.
 */
const COLUMNS =
  "grid grid-cols-[var(--tv-rank-w)_minmax(0,5fr)_minmax(0,4fr)_14.5em_9.5em] items-center gap-[1.5em]";

/**
 * The rank track, sized for as many digits as the board's last rank has: 2.5em
 * a digit, the budget the original two-digit `5em` gave Orbitron's widest pair.
 * Every slots board and any scroll board under a hundred rows keep that `5em`;
 * the event view's list can run past a hundred drivers, where a fixed two-digit
 * track printed "200" into the driver's name.
 */
const rankWidth = (lastRank: number) => `${Math.max(2, String(lastRank).length) * 2.5}em`;

/**
 * Floor on a slot's height, from the tallest thing printed in one: the rank at
 * `2.75em`. This is the fix for rows stacking on top of each other - without it
 * `flex-1` slots divide the leftover height and print over each other once
 * there isn't enough of it.
 */
const ROW_MIN_H = "min-h-[3.75em]";

/** Column headings size themselves rather than the row that holds them, so that
 *  row stays at the base em and its tracks and gap match the slots' exactly. */
const HEADING = "text-[1.125em] font-bold uppercase tracking-[0.3em]";

export type ArcadeEntry = {
  /** React key; a driver id in practice. */
  id: string;
  /** Big line: who holds the slot. */
  name: string;
  /** Small line beside the name: the car the lap was set in. */
  detail: string;
  /** The score itself, in milliseconds, rendered as a lap time. */
  timeMs?: number;
  /**
   * Preformatted score, for a board whose score is not a duration (season
   * points). Wins over `timeMs`: a number that is not a time must never reach
   * the lap-time formatter, which would print 25 points as "0:00.025".
   */
  score?: string;
  /** Preformatted gap, for the same reason. Lap-time boards leave it unset and
   *  the table works the gap to the leader out itself. */
  gap?: string;
  /**
   * Puts an asterisk after the score, with no legend anywhere on the board -
   * the tonight board uses it for a lap that had an incident, and the room is
   * expected to read it as a footnote mark. It hangs in the gutter after the
   * score column rather than inside it, so a marked time stays aligned with
   * the clean ones above and below it.
   */
  asterisk?: boolean;
};

type Props = {
  /** Small line above the title, e.g. "ALL-TIME BEST LAPS". */
  eyebrow: string;
  /** The board's headline, e.g. the track name. */
  title: string;
  /** Optional line under the title, e.g. the layout and driver count. */
  subtitle?: string;
  entries: ArcadeEntry[];
  /** Headings for the three right-hand columns. The defaults describe a lap
   *  board; a board scoring something else renames them rather than lying. */
  columns?: { detail?: string; score?: string; gap?: string };
  /**
   * What an unclaimed slot shows in the score column. Defaults to the lap-time
   * shape, because an open slot on a lap board is an unset time. A board whose
   * score is not a duration passes its own, for the same reason it passes
   * `score` rather than `timeMs` - "--.---" under a POINTS heading reads as a
   * time nobody has driven.
   */
  emptyScore?: string;
  /** Last refresh failed; dim slightly so the room reads it as held, not live. */
  stale?: boolean;
  /**
   * `slots` draws `SLOT_COUNT` rank slots stretched to fill the board; `scroll`
   * draws every entry and scrolls them when they run past the screen; `halves`
   * is `slots` until the entries outgrow it, then every entry in two halves.
   * See the component comment.
   */
  layout?: "slots" | "scroll" | "halves";
};

const RANK_STYLES = [
  "text-gold text-glow-subtle",
  "text-silver",
  "text-bronze",
] as const;

/** The slot's score as text: a board's own preformatted score wins, otherwise
 *  the lap time, otherwise the board's empty-slot placeholder - the same one
 *  the unclaimed rows below use, so a filled row carrying neither can't print a
 *  lap-time shape under a heading that isn't a lap. */
function scoreText(entry: ArcadeEntry, emptyScore: string): string {
  if (entry.score !== undefined) return entry.score;
  return entry.timeMs === undefined ? emptyScore : formatLapTime(entry.timeMs);
}

/** Gap to the leader. Only meaningful between two lap times; a board scoring
 *  anything else supplies its own `gap`. */
function gapText(entry: ArcadeEntry, leader: ArcadeEntry | undefined, index: number): string {
  if (entry.gap !== undefined) return entry.gap;
  if (index === 0 || !leader || entry.timeMs === undefined || leader.timeMs === undefined) {
    return "—";
  }
  return formatGap(entry.timeMs - leader.timeMs);
}

export function ArcadeHighScores({
  eyebrow,
  title,
  subtitle,
  entries,
  columns,
  emptyScore = "--.---",
  stale = false,
  layout = "slots",
}: Props) {
  const leader = entries[0];
  const split = layout === "halves" && entries.length > SPLIT_AFTER;
  const slots =
    layout === "scroll" || split
      ? entries
      : Array.from({ length: SLOT_COUNT }, (_, i) => entries[i] ?? null);
  const {
    detail: detailHeading = "Car",
    score: scoreHeading = "Lap",
    gap: gapHeading = "Gap",
  } = columns ?? {};

  // In the slots layout the rows also stretch (`flex-1`) to fill the board;
  // scrolling rows keep their own height so the list's length is its length.
  // `first` is the rank before the list's first row, so a second half carries
  // on from the first.
  const rows = (list: readonly (ArcadeEntry | null)[], first = 0) => (
    <>
      {list.map((entry, listIndex) => {
        const index = first + listIndex;
        return (
          <li
            key={entry?.id ?? `open-${index}`}
            className={`${COLUMNS} ${ROW_MIN_H} border-b border-edge last:border-b-0 ${
              layout === "scroll" ? "" : "flex-1"
            } ${split ? HALF_ROW_MAX_H : ""} ${entry ? "" : "opacity-30"}`}
          >
            <span
              className={`font-display text-[2.75em]/[1.1] font-black tabular-nums ${
                entry ? RANK_STYLES[index] ?? "text-muted" : "text-muted"
              }`}
            >
              {String(index + 1).padStart(2, "0")}
            </span>

            {entry ? (
              <>
                <span className="truncate text-[2.5em]/[1.1] font-bold">{entry.name}</span>
                <span className="text-muted truncate text-[1.5em]/[1.2] uppercase tracking-wide">
                  {entry.detail}
                </span>
                <span className="laptime relative text-right text-[2.5em]/[1.1] font-bold">
                  {scoreText(entry, emptyScore)}
                  {entry.asterisk && (
                    <>
                      <span
                        data-tv-asterisk
                        aria-hidden="true"
                        className="text-accent absolute top-0 left-full ml-[0.1em]"
                      >
                        *
                      </span>
                      {/* The mark's meaning, for a screen reader: there is no legend on screen. */}
                      <span className="sr-only">lap with an incident</span>
                    </>
                  )}
                </span>
                <span className="laptime text-muted text-right text-[1.5em]/[1.2]">
                  {gapText(entry, leader, index)}
                </span>
              </>
            ) : (
              <>
                <span className="text-muted text-[2.5em]/[1.1] font-bold tracking-[0.3em]">
                  · · · · ·
                </span>
                <span />
                <span className="laptime text-muted text-right text-[2.5em]/[1.1] font-bold">
                  {emptyScore}
                </span>
                <span />
              </>
            )}
          </li>
        );
      })}
    </>
  );

  const headings = (
    <div className={`text-muted shrink-0 ${COLUMNS}`}>
      <span className={HEADING}>Rank</span>
      <span className={HEADING}>Driver</span>
      <span className={HEADING}>{detailHeading}</span>
      <span className={`${HEADING} text-right`}>{scoreHeading}</span>
      <span className={`${HEADING} text-right`}>{gapHeading}</span>
    </div>
  );

  return (
    <section
      className={`flex min-h-0 flex-1 flex-col transition-opacity duration-500 ${
        stale ? "opacity-70" : "opacity-100"
      }`}
      style={{ "--tv-rank-w": rankWidth(slots.length) } as CSSProperties}
    >
      <header className="flex shrink-0 flex-col gap-[0.5em]">
        <p className="font-display text-accent text-glow-subtle text-[1.25em]/[1.4] font-bold uppercase tracking-[0.42em]">
          {eyebrow}
        </p>
        <h1 className="font-display gradient-text truncate text-[4.25em]/[1] font-black uppercase tracking-tight">
          {title}
        </h1>
        {subtitle && (
          <p className="text-muted truncate text-[1.875em]/[1.25]">{subtitle}</p>
        )}
      </header>

      {/* Margin lives on the rule, which sits at the base font size, so both
          gaps mean what they say - a margin on the heading row would be read
          against that row's own smaller text. */}
      <div className="gradient-rule mt-[1.25em] mb-[1em] h-[0.25em] shrink-0 rounded-full" />

      {split ? (
        <div className={`flex min-h-0 flex-1 ${HALVES}`}>
          {splitHalves(slots).map((half, halfIndex) => (
            <div key={halfIndex} className="flex min-h-0 min-w-0 flex-1 flex-col">
              {headings}
              <ol className="mt-[0.25em] flex flex-1 flex-col">
                {rows(half, halfIndex === 0 ? 0 : slots.length - half.length)}
              </ol>
            </div>
          ))}
        </div>
      ) : (
        <>
          {headings}
          {layout === "scroll" ? (
            <AutoScroll rowCount={slots.length}>
              <ol className="mt-[0.25em] flex flex-col">{rows(slots)}</ol>
            </AutoScroll>
          ) : (
            <ol className="mt-[0.25em] flex flex-1 flex-col">{rows(slots)}</ol>
          )}
        </>
      )}
    </section>
  );
}
