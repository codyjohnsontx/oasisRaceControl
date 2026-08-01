"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { formatLapTime } from "@/lib/time";
import { comboLabel, roundLabel, type LeagueRound } from "@/lib/league";
import { SCORING_RULE_SUMMARY, type SeasonStanding } from "@/lib/league-scoring";

type Props = {
  season: { id: string; name: string; league_name: string } | null;
  initialStandings: SeasonStanding[];
  initialRounds: LeagueRound[];
  viewerDriverId: string | null;
};

function StandingRow({
  standing,
  position,
  behind,
  isViewer,
}: {
  standing: SeasonStanding;
  position: number;
  behind: number;
  isViewer: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-[clamp(0.6rem,1.2vw,1.6rem)] rounded-xl border px-[clamp(0.6rem,1vw,1.4rem)] py-[clamp(0.4rem,0.5vw,0.7rem)] ${
        isViewer ? "border-accent bg-surface glow-cyan" : "border-edge bg-surface"
      }`}
    >
      <span
        className={`font-display w-[clamp(1.6rem,2.2vw,2.6rem)] font-black tabular-nums text-[clamp(1.3rem,1.9vw,2.2rem)] ${
          position === 1 ? "text-gold text-glow-subtle" : "text-muted"
        }`}
      >
        {position}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate font-bold text-[clamp(1rem,1.6vw,1.9rem)] leading-tight">
            {standing.display_name}
          </span>
          {isViewer && (
            <span className="shrink-0 text-accent font-bold uppercase tracking-[0.14em] text-[clamp(0.55rem,0.7vw,0.9rem)]">
              you
            </span>
          )}
        </span>
        <span className="block text-muted text-[clamp(0.65rem,0.78vw,0.9rem)] leading-tight">
          {standing.rounds_entered} {standing.rounds_entered === 1 ? "round" : "rounds"}
          {standing.wins > 0 &&
            ` · ${standing.wins} ${standing.wins === 1 ? "win" : "wins"}`}
          {standing.best_position !== null &&
            standing.wins === 0 &&
            ` · best P${standing.best_position}`}
        </span>
      </span>

      {/* Per-round breakdown: useful on the wall, noise on a phone. */}
      <span className="hidden md:flex flex-wrap justify-end gap-1.5 max-w-[45%]">
        {standing.rounds.map((entry) => (
          <span
            key={entry.round_id}
            title={entry.position === null ? "No valid lap" : `Finished P${entry.position}`}
            className="flex items-baseline gap-1 rounded-md border border-edge bg-raised px-2 py-0.5 text-[clamp(0.6rem,0.75vw,0.95rem)]"
          >
            <span className="text-muted">R{entry.round_number}</span>
            <span className="laptime font-bold">{entry.points}</span>
          </span>
        ))}
      </span>

      <span className="w-[clamp(3rem,4vw,5.5rem)] text-right">
        <span className="laptime block font-black leading-none text-[clamp(1.3rem,1.9vw,2.2rem)]">
          {standing.points}
        </span>
        <span className="laptime block text-muted leading-tight text-[clamp(0.6rem,0.72vw,0.85rem)]">
          {/* A driver level on points with the leader is behind on the
              tiebreak, not by "-0". */}
          {position === 1 ? "leader" : behind === 0 ? "level" : `-${behind}`}
        </span>
      </span>
    </div>
  );
}

type RoundSummary = { winner: string | null; bestLapMs: number | null; drivers: number };

/** Winner and field size per round, read straight off the standings so the
 *  round strip can never drift from the table above it. */
function summarizeRounds(standings: SeasonStanding[]): Record<string, RoundSummary> {
  const summaries: Record<string, RoundSummary> = {};
  for (const standing of standings) {
    for (const entry of standing.rounds) {
      const summary = (summaries[entry.round_id] ??= {
        winner: null,
        bestLapMs: null,
        drivers: 0,
      });
      summary.drivers += 1;
      if (entry.position === 1) {
        summary.winner = standing.display_name;
        summary.bestLapMs = entry.best_lap_ms;
      }
    }
  }
  return summaries;
}

const POLL_MS = 10_000;

/**
 * The league board. Its own route (never wired into /tv), sized to be read
 * across the room at 1920x1080 - every size is a clamp() against viewport
 * width, so the same page is a normal phone page at 390px.
 */
export function LeagueStandings({
  season,
  initialStandings,
  initialRounds,
  viewerDriverId,
}: Props) {
  const [standings, setStandings] = useState(initialStandings);
  const [rounds, setRounds] = useState(initialRounds);
  const roundSummaries = useMemo(() => summarizeRounds(standings), [standings]);
  const columns = useMemo(() => {
    if (standings.length <= 8) return [standings];
    const half = Math.ceil(standings.length / 2);
    return [standings.slice(0, half), standings.slice(half)];
  }, [standings]);
  const columnOffsets = columns.map((_, index) =>
    columns.slice(0, index).reduce((sum, column) => sum + column.length, 0),
  );

  const refresh = useCallback(async () => {
    if (!season) return;
    try {
      const res = await fetch(`/api/league/season?season=${season.id}`, { cache: "no-store" });
      if (!res.ok) return; // the wall screen keeps the last good board
      const payload = (await res.json()) as {
        standings: SeasonStanding[];
        rounds: LeagueRound[];
      };
      if (Array.isArray(payload.standings)) setStandings(payload.standings);
      if (Array.isArray(payload.rounds)) setRounds(payload.rounds);
    } catch {
      // transient failure - next tick retries
    }
  }, [season]);

  useEffect(() => {
    const poll = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(poll);
  }, [refresh]);

  const liveRound = rounds.find((round) => round.closed_at === null) ?? null;

  return (
    <main className="flex-1 w-full flex flex-col gap-[clamp(0.75rem,1.05vw,1.4rem)] px-[clamp(1rem,2.5vw,3.5rem)] pt-[clamp(1.25rem,2vw,2.5rem)] pb-[clamp(2rem,1.5vw,2rem)]">
      {/* pr clears the app-wide fixed "Screens" button in the top right. */}
      <header className="flex items-start justify-between gap-6 pr-[7.5rem]">
        <div className="min-w-0">
          <p className="font-display text-accent text-glow-subtle font-bold uppercase tracking-[0.24em] text-[clamp(0.6rem,0.85vw,1.1rem)]">
            {season?.league_name ?? "Oasis League"}
          </p>
          <h1 className="font-display gradient-text font-black tracking-tight uppercase text-[clamp(1.9rem,4.4vw,5rem)] leading-[1.05]">
            Season Standings
          </h1>
          <p className="text-muted text-[clamp(0.8rem,1.15vw,1.6rem)] mt-1">
            {season ? season.name : "No season yet"}
            {rounds.length > 0 && ` · ${rounds.length} ${rounds.length === 1 ? "round" : "rounds"}`}
          </p>
        </div>
        <div className="hidden sm:flex items-center gap-4 shrink-0">
          {liveRound && (
            <span className="flex items-center gap-2 rounded-full border border-valid px-3 py-1.5 text-valid font-bold uppercase tracking-[0.16em] text-[clamp(0.6rem,0.8vw,1rem)]">
              <span className="h-2 w-2 rounded-full bg-valid animate-pulse" aria-hidden />
              {roundLabel(liveRound)} live
            </span>
          )}
          <Image
            src="/oasishelmet.png"
            alt=""
            width={49}
            height={60}
            priority
            className="h-[clamp(2.2rem,3.4vw,4rem)] w-auto"
          />
        </div>
      </header>

      <div className="gradient-rule h-1 rounded-full" />

      {standings.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center py-16">
          <p className="text-muted text-[clamp(1rem,1.8vw,2rem)]">
            No league results yet.
          </p>
          <p className="text-muted text-[clamp(0.8rem,1.1vw,1.3rem)] max-w-md">
            Staff open a round from the staff dashboard; every clean lap on the
            round&apos;s combo lands here automatically.
          </p>
        </div>
      ) : (
        <section aria-label="Season standings" className="flex flex-col gap-2">
          {/* A full Wednesday field is 20+ drivers. Past eight, the board splits
              into two columns so the wall screen shows everyone without
              scrolling; stacked on a phone it still reads 1, 2, 3... */}
          <div className="flex flex-col xl:flex-row gap-x-[clamp(1rem,2vw,2.5rem)] gap-y-1">
            {columns.map((column, columnIndex) => (
              <div
                key={columnIndex}
                className="flex-1 min-w-0 flex flex-col gap-[clamp(0.3rem,0.45vw,0.6rem)]"
              >
                {/* Stacked (phone, laptop) the two halves are one list, so only
                    the first gets a header; side by side both do. */}
                <div
                  className={`items-center gap-[clamp(0.6rem,1.2vw,1.6rem)] px-[clamp(0.6rem,1vw,1.4rem)] text-muted uppercase tracking-[0.18em] text-[clamp(0.55rem,0.72vw,0.9rem)] ${
                    columnIndex === 0 ? "flex" : "hidden xl:flex"
                  }`}
                >
                  <span className="w-[clamp(1.6rem,2.2vw,2.6rem)]">Pos</span>
                  <span className="flex-1">Driver</span>
                  <span className="hidden md:block">Rounds</span>
                  <span className="w-[clamp(3rem,4vw,5.5rem)] text-right">Pts</span>
                </div>

                {column.map((standing, indexInColumn) => (
                  <StandingRow
                    key={standing.driver_id}
                    standing={standing}
                    position={columnOffsets[columnIndex] + indexInColumn + 1}
                    behind={standings[0].points - standing.points}
                    isViewer={standing.driver_id === viewerDriverId}
                  />
                ))}
              </div>
            ))}
          </div>

          <p className="text-muted text-[clamp(0.6rem,0.8vw,1rem)] px-[clamp(0.6rem,1vw,1.4rem)]">
            Scoring · {SCORING_RULE_SUMMARY}
          </p>
        </section>
      )}

      {rounds.length > 0 && (
        <section aria-label="Rounds" className="flex flex-col gap-3">
          <h2 className="text-muted font-bold uppercase tracking-[0.18em] text-[clamp(0.6rem,0.8vw,1rem)]">
            Rounds · tap for the full field
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rounds.map((round) => {
              const summary = roundSummaries[round.id];
              const live = round.closed_at === null;
              return (
                <li key={round.id}>
                  <Link
                    href={`/league/${round.id}`}
                    className={`flex flex-col gap-0.5 rounded-2xl border bg-surface px-4 py-2.5 transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                      live ? "border-valid" : "border-edge"
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-display font-bold uppercase tracking-[0.1em] text-[clamp(0.85rem,1.1vw,1.4rem)]">
                        {roundLabel(round)}
                      </span>
                      <span
                        className={`text-[clamp(0.55rem,0.72vw,0.9rem)] font-bold uppercase tracking-[0.14em] ${
                          live ? "text-valid" : "text-muted"
                        }`}
                      >
                        {live ? "Live" : round.round_date}
                      </span>
                    </span>
                    <span className="text-muted text-[clamp(0.7rem,0.9vw,1.05rem)] line-clamp-2">
                      {comboLabel(round)}
                    </span>
                    <span className="flex items-baseline justify-between gap-2 text-[clamp(0.7rem,0.9vw,1.05rem)]">
                      <span className="truncate">
                        {summary?.winner ? (
                          <>
                            <span className="text-gold font-bold">P1 {summary.winner}</span>
                            {summary.bestLapMs !== null && (
                              <span className="laptime text-muted">
                                {" "}
                                {formatLapTime(summary.bestLapMs)}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted">No times yet</span>
                        )}
                      </span>
                      <span className="text-muted shrink-0 text-[clamp(0.65rem,0.8vw,0.95rem)]">
                        {summary?.drivers ?? 0}{" "}
                        {(summary?.drivers ?? 0) === 1 ? "driver" : "drivers"}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}
