import { formatGap, formatLapTime } from "@/lib/time";

/**
 * Shared presentation for `/tv` boards: a fixed-height arcade high-score table,
 * sized to be read from across the shop. Board types feed it entries; it owns
 * nothing about loading or rotation.
 *
 * Every board renders the same `SLOT_COUNT` rank slots whether or not they're
 * filled. That's deliberate on two counts: an arcade table with unclaimed slots
 * reads as an invitation rather than as a bug, and a constant row height keeps
 * the layout from jumping as the rotation moves between a busy board and a
 * quiet one.
 */

/** Rank slots drawn on every board - filled ones show a driver, the rest sit open. */
export const SLOT_COUNT = 10;

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
 *  the lap time, otherwise the empty-slot placeholder. */
function scoreText(entry: ArcadeEntry): string {
  if (entry.score !== undefined) return entry.score;
  return entry.timeMs === undefined ? "--.---" : formatLapTime(entry.timeMs);
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
      <header className="shrink-0">
        <p className="font-display text-accent text-glow-subtle text-xl font-bold uppercase tracking-[0.42em]">
          {eyebrow}
        </p>
        <h1 className="font-display gradient-text mt-2 truncate text-[4.25rem] font-black uppercase leading-none tracking-tight">
          {title}
        </h1>
        {subtitle && (
          <p className="text-muted mt-2 truncate text-3xl">{subtitle}</p>
        )}
      </header>

      <div className="gradient-rule mt-5 h-1 shrink-0 rounded-full" />

      <div className="text-muted mt-4 flex shrink-0 items-center gap-8 text-lg font-bold uppercase tracking-[0.3em]">
        <span className="w-24">Rank</span>
        <span className="w-[30rem]">Driver</span>
        <span className="flex-1">{detailHeading}</span>
        <span className="w-64 text-right">{scoreHeading}</span>
        <span className="w-44 text-right">{gapHeading}</span>
      </div>

      <ol className="mt-1 flex min-h-0 flex-1 flex-col">
        {slots.map((entry, index) => (
          <li
            key={entry?.id ?? `open-${index}`}
            className={`flex min-h-0 flex-1 items-center gap-8 border-b border-edge last:border-b-0 ${
              entry ? "" : "opacity-30"
            }`}
          >
            <span
              className={`font-display w-24 text-[2.75rem] font-black tabular-nums ${
                entry ? RANK_STYLES[index] ?? "text-muted" : "text-muted"
              }`}
            >
              {String(index + 1).padStart(2, "0")}
            </span>

            {entry ? (
              <>
                <span className="w-[30rem] truncate text-[2.5rem] font-bold">
                  {entry.name}
                </span>
                <span className="text-muted flex-1 truncate text-2xl uppercase tracking-wide">
                  {entry.detail}
                </span>
                <span className="laptime w-64 text-right text-[2.5rem] font-bold">
                  {scoreText(entry)}
                </span>
                <span className="laptime text-muted w-44 text-right text-2xl">
                  {gapText(entry, leader, index)}
                </span>
              </>
            ) : (
              <>
                <span className="text-muted w-[30rem] text-[2.5rem] font-bold tracking-[0.3em]">
                  · · · · ·
                </span>
                <span className="flex-1" />
                <span className="laptime text-muted w-64 text-right text-[2.5rem] font-bold">
                  {emptyScore}
                </span>
                <span className="w-44" />
              </>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
