"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { formatLapTime, formatGap } from "@/lib/time";
import {
  type Board,
  type BoardRow,
  type BoardWindow,
  trackKey,
  trackLabel,
} from "@/lib/leaderboards";

type Props = {
  boards: Board[];
  viewerDriverId: string | null;
};

const POLL_MS = 5000;

export function Leaderboards({ boards, viewerDriverId }: Props) {
  // Each board is a track layout; the car is shown per row, not selected.
  const [boardKey, setBoardKey] = useState<string>(boards[0] ? trackKey(boards[0]) : "");
  const [window, setWindow] = useState<BoardWindow>("alltime");
  const [rows, setRows] = useState<BoardRow[]>([]);

  const selected = useMemo(
    () => boards.find((b) => trackKey(b) === boardKey) ?? boards[0] ?? null,
    [boards, boardKey],
  );

  const refresh = useCallback(
    async (clear: boolean) => {
      if (!selected) return;
      if (clear) setRows([]); // drop the previous board while a new one loads
      const params = new URLSearchParams({ track: selected.track_name, window });
      if (selected.track_config) params.set("config", selected.track_config);
      try {
        const res = await fetch(`/api/leaderboards/board?${params}`, { cache: "no-store" });
        if (!res.ok) return; // keep last-known rows on a transient failure
        const data = (await res.json()) as { rows: BoardRow[] };
        if (Array.isArray(data.rows)) setRows(data.rows);
      } catch {
        // transient network failure — try again next tick
      }
    },
    [selected, window],
  );

  useEffect(() => {
    // Defer the first load (which clears stale rows) to a timer so no setState
    // runs synchronously in the effect body; the poll keeps it fresh.
    const initial = setTimeout(() => void refresh(true), 0);
    const poll = setInterval(() => void refresh(false), POLL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(poll);
    };
  }, [refresh]);

  const leader = rows[0];

  return (
    <main className="grid-bg flex-1 flex flex-col gap-6 p-6 max-w-3xl w-full mx-auto">
      <header className="flex items-center justify-between gap-4">
        <h1 className="font-display gradient-text text-4xl sm:text-5xl font-black tracking-tight">
          LEADERBOARDS
        </h1>
        <Link href="/" className="text-muted text-sm underline underline-offset-4">
          Home
        </Link>
      </header>
      <div className="gradient-rule h-1 rounded-full" />

      {boards.length === 0 ? (
        <p className="text-muted text-lg mt-8 text-center">
          No leaderboards yet — go set a lap.
        </p>
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <label htmlFor="lb-track" className="sr-only">
              Track
            </label>
            <select
              id="lb-track"
              value={boardKey}
              onChange={(e) => setBoardKey(e.target.value)}
              className="bg-surface border border-edge rounded-lg px-3 py-2 text-sm"
            >
              {boards.map((b) => (
                <option key={trackKey(b)} value={trackKey(b)}>
                  {trackLabel(b)}
                </option>
              ))}
            </select>

            {/* All-time / Tonight segmented toggle (auth-forms tab pattern). */}
            <div className="flex gap-1 bg-surface rounded-lg p-1 self-start">
              {(["alltime", "tonight"] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setWindow(w)}
                  className={`px-4 py-1.5 text-sm font-bold uppercase tracking-wider rounded-md ${
                    window === w ? "bg-accent text-bg" : "text-muted"
                  }`}
                >
                  {w === "alltime" ? "All-time" : "Tonight"}
                </button>
              ))}
            </div>
          </section>

          <section className="flex-1">
            {rows.length === 0 ? (
              <p className="text-muted text-sm">
                {window === "tonight"
                  ? "No laps on this board yet tonight."
                  : "No laps on this board yet."}
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {rows.map((row, index) => {
                  const isYou = viewerDriverId != null && row.driver_id === viewerDriverId;
                  return (
                    <div
                      key={row.driver_id}
                      className={`flex items-center gap-4 rounded-xl px-4 py-3 border ${
                        isYou ? "border-accent glow-cyan bg-surface" : "border-edge bg-surface"
                      }`}
                    >
                      <span
                        className={`font-display w-10 text-2xl font-black ${
                          index === 0 ? "text-gold text-glow-subtle" : "text-muted"
                        }`}
                      >
                        {index + 1}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="truncate font-bold">
                          {row.display_name}
                          {isYou && (
                            <span className="ml-2 text-accent text-xs font-bold uppercase tracking-wider">
                              you
                            </span>
                          )}
                        </p>
                        <p className="text-muted text-xs truncate">{row.car_name}</p>
                      </div>
                      <span className="laptime text-xl font-bold">
                        {formatLapTime(row.lap_time_ms)}
                      </span>
                      <span className="laptime text-sm text-muted w-24 text-right">
                        {index === 0 || !leader
                          ? ""
                          : formatGap(row.lap_time_ms - leader.lap_time_ms)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
