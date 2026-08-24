import { formatGap, formatLapTime } from "@/lib/time";

/**
 * Shared presentation for `/tv` boards: an arcade high-score table, sized to be
 * read from across the shop. Board types feed it entries; it owns nothing about
 * loading or rotation.
 *
 * Every board renders the same `SLOT_COUNT` rank slots whether or not they're
 * filled. That's deliberate on two counts: an arcade table with unclaimed slots
 * reads as an invitation rather than as a bug, and a constant row height keeps
 * the layout from jumping as the rotation moves between a busy board and a
 * quiet one.
 *
 * Sizing: every length here is in `em` of `.tv-scale` (see `globals.css`), so
 * the table is one 1920x1080 composition scaled to whatever panel it lands on
 * rather than a set of pixel sizes that happen to suit one. The two rules that
 * keep it whole on the venue's 1272x601 wall:
 *
 *  - Columns whose content varies - driver and detail - are `fr` tracks, so
 *    they divide whatever the fixed ones leave rather than being handed a
 *    number tuned on a laptop. Only the two monospace score columns are fixed,
 *    because a lap time genuinely is a fixed number of characters wide.
 *  - Rows carry a minimum height set by the text in them (`ROW_MIN_H`), so ten
 *    of them can never be compressed into less height than they need to print.
 *    They still stretch to fill a taller screen; they just cannot collapse.
 */

/** Rank slots drawn on every board - filled ones show a driver, the rest sit open. */
export const SLOT_COUNT = 10;

/**
 * The table's columns, shared by the heading row and every slot so the two stay
 * in step. Rank and the two score columns are fixed because their content is:
 * two tabular digits (sized for Orbitron's widest pair, not for "01"), a lap
 * time, a gap - all fixed-width by nature. Both are sized for the widest string
 * their formatter can produce, not the common one: `formatGap` switches to
 * `+1:23.874` past a minute and `+10:01.204` past ten, which an all-time board
 * of a long track reaches. Everything left over goes to driver
 * and detail in a 5:4 split, which is roughly the ratio of their longest real
 * content - a 24-character display name (the cap in `driver-auth.ts`) at
 * `2.5em` against a car name at `1.5em`.
 */
const COLUMNS =
  "grid grid-cols-[5em_minmax(0,5fr)_minmax(0,4fr)_13em_9.5em] items-center gap-[1.5em]";

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
}: Props) {
  const leader = entries[0];
  const slots = Array.from({ length: SLOT_COUNT }, (_, i) => entries[i] ?? null);
  const {
    detail: detailHeading = "Car",
    score: scoreHeading = "Lap",
    gap: gapHeading = "Gap",
  } = columns ?? {};

  return (
    <section
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
        {subtitle && (
          <p className="text-muted truncate text-[1.875em]/[1.25]">{subtitle}</p>
        )}
      </header>

      {/* Margin lives on the rule, which sits at the base font size, so both
          gaps mean what they say - a margin on the heading row would be read
          against that row's own smaller text. */}
      <div className="gradient-rule mt-[1.25em] mb-[1em] h-[0.25em] shrink-0 rounded-full" />

      <div className={`text-muted shrink-0 ${COLUMNS}`}>
        <span className={HEADING}>Rank</span>
        <span className={HEADING}>Driver</span>
        <span className={HEADING}>{detailHeading}</span>
        <span className={`${HEADING} text-right`}>{scoreHeading}</span>
        <span className={`${HEADING} text-right`}>{gapHeading}</span>
      </div>

      <ol className="mt-[0.25em] flex flex-1 flex-col">
        {slots.map((entry, index) => (
          <li
            key={entry?.id ?? `open-${index}`}
            className={`${COLUMNS} ${ROW_MIN_H} flex-1 border-b border-edge last:border-b-0 ${
              entry ? "" : "opacity-30"
            }`}
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
                <span className="laptime text-right text-[2.5em]/[1.1] font-bold">
                  {scoreText(entry, emptyScore)}
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
        ))}
      </ol>
    </section>
  );
}
