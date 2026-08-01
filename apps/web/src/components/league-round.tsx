"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { formatGap, formatLapTime } from "@/lib/time";
import {
  comboLabel,
  invalidReasonLabel,
  MAX_ROUND_DRIVERS,
  ROUND_LAP_CAP,
  roundLabel,
  type LeagueRound,
  type RoundLap,
  type RoundResult,
} from "@/lib/league";
import { useVisiblePoll } from "@/components/use-visible-poll";

type Props = {
  round: LeagueRound;
  initialField: RoundResult[];
  /** Every attributed lap, grouped by driver, so the first tap expands with no
   *  network round trip. Polling then refreshes only what is open. */
  initialLaps: Record<string, RoundLap[]>;
  /** The round had more laps than one request returns - say so rather than
   *  showing a subset as if it were the whole round. */
  initialTruncated: boolean;
  viewerDriverId: string | null;
};

const POLL_MS = 6000;

function roundUrl(roundId: string, driverIds: string[]): string {
  const base = `/api/league/rounds/${roundId}`;
  const asked = driverIds.slice(0, MAX_ROUND_DRIVERS);
  return asked.length > 0 ? `${base}?drivers=${asked.join(",")}` : base;
}

/**
 * The post-race comparison customers asked for: the round's full field in one
 * ranked list, tap any driver to see every lap they ran.
 *
 * Built for a phone held one-handed in the paddock - rows are full-width tap
 * targets, times sit in a fixed mono column so they compare down the page, and
 * nothing needs a horizontal scroll at 390px.
 */
export function LeagueRound({
  round,
  initialField,
  initialLaps,
  initialTruncated,
  viewerDriverId,
}: Props) {
  // The round itself is state, not just a prop: staff can close it while a
  // customer has this page open, and the poll response is how that phone finds
  // out. Reading `closed_at` off the prop would leave it polling all night.
  const [current, setCurrent] = useState(round);
  const [field, setField] = useState(initialField);
  const [laps, setLaps] = useState(initialLaps);
  const [truncated, setTruncated] = useState(initialTruncated);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // Your own row starts open - the first thing a driver wants after a stint
    // is their own laps, without hunting for their name.
    const viewerRow = viewerDriverId
      ? initialField.find((row) => row.driver_id === viewerDriverId)
      : null;
    return new Set(viewerRow ? [viewerRow.driver_id] : []);
  });

  const isOpen = current.closed_at === null;

  // One request per tick, carrying the ranking and every expanded driver's
  // laps - a phone with twenty rows open still polls once.
  const refresh = useCallback(async () => {
    const open = [...expanded];
    try {
      const res = await fetch(roundUrl(round.id, open), { cache: "no-store" });
      if (!res.ok) return; // keep the last good board on a transient failure
      const payload = (await res.json()) as {
        round?: LeagueRound;
        field?: RoundResult[];
        laps?: Record<string, RoundLap[]> | null;
        truncated?: boolean;
      };
      if (payload.round) setCurrent(payload.round);
      if (Array.isArray(payload.field)) setField(payload.field);
      if (payload.laps) setLaps((prev) => ({ ...prev, ...payload.laps }));
      if (typeof payload.truncated === "boolean" && open.length > 0) {
        setTruncated(payload.truncated);
      }
    } catch {
      // transient network failure - the next tick tries again
    }
  }, [round.id, expanded]);

  // A closed round can't change under you, so it stops polling - including
  // when it closes while this page is open.
  useVisiblePoll(refresh, POLL_MS, isOpen);

  function toggle(driverId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(driverId)) next.delete(driverId);
      else next.add(driverId);
      return next;
    });

    // A driver who joined the round after this page rendered has no laps in
    // the initial payload; fetch theirs on the tap rather than on the next poll.
    if (!laps[driverId]) {
      void fetch(roundUrl(round.id, [driverId]), { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((body: { laps?: Record<string, RoundLap[]> | null } | null) => {
          const fresh = body?.laps?.[driverId];
          if (Array.isArray(fresh)) setLaps((prev) => ({ ...prev, [driverId]: fresh }));
        })
        .catch(() => {});
    }
  }

  const leaderMs = field.find((row) => row.best_lap_ms !== null)?.best_lap_ms ?? null;
  const totalLaps = useMemo(
    () => field.reduce((sum, row) => sum + row.lap_count, 0),
    [field],
  );

  return (
    <main className="flex-1 w-full max-w-2xl mx-auto flex flex-col gap-5 px-4 pt-5 pb-16">
      {/* pr clears the app-wide fixed "Screens" button in the top right. */}
      <header className="flex flex-col gap-3 pr-[7.5rem]">
        <div className="flex items-center gap-3">
          <Link
            href="/league"
            className="text-muted text-sm underline underline-offset-4 shrink-0"
          >
            ← Season
          </Link>
          <span className="text-muted text-xs uppercase tracking-[0.18em] truncate">
            {current.season_name}
          </span>
        </div>

        <div className="flex items-start justify-between gap-3">
          <h1 className="font-display gradient-text text-3xl sm:text-4xl font-black tracking-tight uppercase min-w-0">
            {roundLabel(current)}
          </h1>
          <span
            className={`shrink-0 mt-1 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] ${
              isOpen ? "border-valid text-valid" : "border-edge text-muted"
            }`}
          >
            {isOpen && (
              <span className="h-1.5 w-1.5 rounded-full bg-valid animate-pulse" aria-hidden />
            )}
            {isOpen ? "Live" : "Final"}
          </span>
        </div>

        <p className="text-muted text-sm leading-snug">{comboLabel(current)}</p>
        <p className="text-muted text-xs">
          {current.round_date} · {field.length} {field.length === 1 ? "driver" : "drivers"} ·{" "}
          {totalLaps} {totalLaps === 1 ? "lap" : "laps"}
        </p>
        {truncated && (
          <p className="text-sunset text-xs">
            This round ran past {ROUND_LAP_CAP.toLocaleString("en-US")} laps - the
            expanded lists show the earliest ones.
          </p>
        )}
      </header>

      <div className="gradient-rule h-1 rounded-full" />

      {field.length === 0 ? (
        <p className="text-muted text-center text-sm mt-10">
          {isOpen
            ? "No laps in this round yet. Check in at a rig and go set one."
            : "Nobody set a lap in this round."}
        </p>
      ) : (
        <>
          <p className="text-muted text-[11px] uppercase tracking-[0.16em]">
            Tap a driver for every lap
          </p>
          <ol className="flex flex-col gap-2">
            {field.map((row) => (
              <FieldRow
                key={row.driver_id}
                row={row}
                leaderMs={leaderMs}
                isViewer={row.driver_id === viewerDriverId}
                expanded={expanded.has(row.driver_id)}
                laps={laps[row.driver_id] ?? []}
                onToggle={() => toggle(row.driver_id)}
              />
            ))}
          </ol>
        </>
      )}
    </main>
  );
}

function FieldRow({
  row,
  leaderMs,
  isViewer,
  expanded,
  laps,
  onToggle,
}: {
  row: RoundResult;
  leaderMs: number | null;
  isViewer: boolean;
  expanded: boolean;
  laps: RoundLap[];
  onToggle: () => void;
}) {
  const gapMs =
    row.best_lap_ms !== null && leaderMs !== null ? row.best_lap_ms - leaderMs : null;

  return (
    <li
      className={`rounded-2xl border overflow-hidden ${
        isViewer ? "border-accent bg-surface glow-cyan" : "border-edge bg-surface"
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full text-left px-3 py-3 flex items-center gap-3 min-h-14 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
      >
        <span
          className={`font-display w-9 shrink-0 text-center text-2xl font-black tabular-nums ${
            row.position === 1 ? "text-gold text-glow-subtle" : "text-muted"
          }`}
        >
          {row.position ?? "—"}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-bold text-[15px]">{row.display_name}</span>
            {isViewer && (
              <span className="shrink-0 text-accent text-[10px] font-bold uppercase tracking-[0.14em]">
                you
              </span>
            )}
          </span>
          <span className="mt-0.5 block text-muted text-xs">
            {row.lap_count} {row.lap_count === 1 ? "lap" : "laps"} ·{" "}
            {row.valid_lap_count} clean
          </span>
        </span>

        <span className="shrink-0 text-right">
          <span className="laptime block text-lg font-bold leading-tight">
            {row.best_lap_ms === null ? (
              <span className="text-muted text-sm font-normal">no time</span>
            ) : (
              formatLapTime(row.best_lap_ms)
            )}
          </span>
          <span className="laptime block text-xs text-muted leading-tight">
            {gapMs === null ? "" : gapMs === 0 ? "leader" : formatGap(gapMs)}
          </span>
        </span>

        <span
          aria-hidden
          className={`shrink-0 text-muted text-xs transition-transform duration-200 ${
            expanded ? "rotate-180" : ""
          }`}
        >
          ▼
        </span>
      </button>

      {expanded && <DriverLaps laps={laps} leaderMs={leaderMs} bestMs={row.best_lap_ms} />}
    </li>
  );
}

function DriverLaps({
  laps,
  leaderMs,
  bestMs,
}: {
  laps: RoundLap[];
  leaderMs: number | null;
  bestMs: number | null;
}) {
  if (laps.length === 0) {
    return (
      <p className="border-t border-edge px-3 py-3 text-muted text-xs">
        No laps recorded for this driver yet.
      </p>
    );
  }

  // Background bars span this driver's own fastest-to-slowest range, not the
  // gap to the leader - the "vs leader" column already carries that. Scaled
  // this way a metronomic stint reads as an even block and a scrappy one is
  // obvious, whether the driver is on pole or ten seconds off it.
  const validTimes = laps.filter((lap) => lap.is_valid).map((lap) => lap.lap_time_ms);
  const fastest = validTimes.length > 0 ? Math.min(...validTimes) : 0;
  const spread = validTimes.length > 0 ? Math.max(...validTimes) - fastest : 0;

  return (
    <div className="border-t border-edge bg-bg/40 px-3 py-2">
      <div className="flex items-center gap-2 pb-1 text-[10px] uppercase tracking-[0.14em] text-muted">
        <span className="w-7">Lap</span>
        <span className="w-[4.6rem] text-right">Time</span>
        <span className="flex-1" />
        <span className="w-[4.2rem] text-right">vs leader</span>
      </div>
      <ol className="flex flex-col">
        {laps.map((lap, index) => {
          const deficit = leaderMs === null ? null : lap.lap_time_ms - leaderMs;
          const isBest = bestMs !== null && lap.is_valid && lap.lap_time_ms === bestMs;
          const barPct =
            lap.is_valid && spread > 0
              ? Math.max(4, ((lap.lap_time_ms - fastest) / spread) * 100)
              : lap.is_valid
                ? 4
                : 0;
          return (
            <li
              key={lap.id}
              className={`relative flex items-center gap-2 border-t border-edge/60 first:border-t-0 py-1.5 ${
                lap.is_valid ? "" : "opacity-55"
              }`}
            >
              {lap.is_valid && (
                <span
                  aria-hidden
                  className={`absolute inset-y-0.5 left-0 rounded-r-sm ${
                    isBest ? "bg-valid/20" : "bg-accent/12"
                  }`}
                  style={{ width: `${barPct}%` }}
                />
              )}
              <span className="laptime relative w-7 text-xs text-muted">
                {lap.lap_number ?? index + 1}
              </span>
              <span
                className={`laptime relative w-[4.6rem] text-right text-sm font-bold ${
                  isBest ? "text-valid" : ""
                }`}
              >
                {formatLapTime(lap.lap_time_ms)}
              </span>
              <span className="relative flex-1 min-w-0 text-right">
                {lap.is_valid
                  ? isBest && (
                      <span className="text-valid text-[10px] font-bold uppercase tracking-[0.12em]">
                        best
                      </span>
                    )
                  : (
                      <span className="text-invalid text-[10px] font-bold uppercase tracking-[0.12em]">
                        {invalidReasonLabel(lap.invalid_reason)}
                      </span>
                    )}
              </span>
              <span className="laptime relative w-[4.2rem] text-right text-xs text-muted">
                {lap.is_valid && deficit !== null ? formatGap(deficit) : ""}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
