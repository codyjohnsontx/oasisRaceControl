"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { formatLapTime, formatGap } from "@/lib/time";

type Row = {
  driver_id: string;
  display_name: string;
  lap_time_ms: number;
};

type Combo = {
  track_name: string;
  track_config: string | null;
  car_name: string;
};

type Interstitial = {
  displayName: string;
  lapTimeMs: number;
  improvementMs: number;
  rank: number;
};

const ROW_HEIGHT = 88;
const POLL_MS = 5000;

/** Front-of-store leaderboard. Polls the API every few seconds — at venue
 * scale that's indistinguishable from push, with far fewer moving parts.
 * Fixed-position rows animate to their new rank (absolute + translateY). */
export default function TvPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [combo, setCombo] = useState<Combo | null>(null);
  const [interstitial, setInterstitial] = useState<Interstitial | null>(null);
  const previousBests = useRef<Map<string, number>>(new Map());
  const interstitialTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    let payload: { rows: Row[]; combo: Combo | null };
    try {
      const res = await fetch("/api/leaderboard/tonight", { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      payload = await res.json();
    } catch (error) {
      // The TV runs unattended for hours: on a transient failure, keep showing
      // the last known standings instead of a falsely empty board.
      console.error("[tv] leaderboard refresh failed", (error as Error).message);
      return;
    }

    const next = payload.rows ?? [];
    setCombo(payload.combo ?? null);

    // Personal-best interstitial: a driver's best tonight just improved.
    const prev = previousBests.current;
    if (prev.size > 0) {
      for (const [rank, row] of next.entries()) {
        const before = prev.get(row.driver_id);
        if (before !== undefined && row.lap_time_ms < before) {
          setInterstitial({
            displayName: row.display_name,
            lapTimeMs: row.lap_time_ms,
            improvementMs: before - row.lap_time_ms,
            rank: rank + 1,
          });
          if (interstitialTimer.current) clearTimeout(interstitialTimer.current);
          interstitialTimer.current = setTimeout(() => setInterstitial(null), 7000);
          break;
        }
      }
    }
    previousBests.current = new Map(next.map((r) => [r.driver_id, r.lap_time_ms]));
    setRows(next);
  }, []);

  useEffect(() => {
    // First paint happens immediately with empty state; data arrives a tick
    // later (also keeps setState out of the synchronous effect body).
    const initial = setTimeout(() => void refresh(), 0);
    const poll = setInterval(() => void refresh(), POLL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(poll);
      if (interstitialTimer.current) {
        clearTimeout(interstitialTimer.current);
        interstitialTimer.current = null;
      }
    };
  }, [refresh]);

  const leader = rows[0];

  return (
    <main className="grid-bg flex-1 flex flex-col p-10 select-none overflow-hidden">
      <header className="flex items-end justify-between pb-4">
        <div>
          <h1 className="font-display gradient-text text-6xl font-black tracking-tight">
            FASTEST TONIGHT
          </h1>
          {combo && (
            <p className="text-muted text-2xl mt-1">
              {combo.track_name}
              {combo.track_config ? ` — ${combo.track_config}` : ""} ·{" "}
              {combo.car_name}
            </p>
          )}
        </div>
        <div className="flex items-center gap-4 pb-1">
          <Image
            src="/oasishelmet.png"
            alt=""
            width={49}
            height={60}
            priority
            className="h-14 w-auto"
          />
          <p className="font-display text-accent text-glow-subtle font-bold tracking-[0.3em] text-xl uppercase">
            Oasis Live Timing
          </p>
        </div>
      </header>
      <div className="gradient-rule h-1 rounded-full" />

      <div className="relative flex-1 mt-6" style={{ minHeight: rows.length * ROW_HEIGHT }}>
        {rows.length === 0 && (
          <p className="text-muted text-3xl mt-16 text-center">
            No laps yet tonight — go set one.
          </p>
        )}
        {rows.map((row, index) => (
          <div
            key={row.driver_id}
            className="absolute left-0 right-0 flex items-center gap-8 border-b border-edge transition-transform duration-700 ease-in-out"
            style={{ height: ROW_HEIGHT, transform: `translateY(${index * ROW_HEIGHT}px)` }}
          >
            <span
              className={`w-20 text-5xl font-black font-display ${
                index === 0 ? "text-gold text-glow-subtle" : "text-muted"
              }`}
            >
              {index + 1}
            </span>
            <span className="flex-1 text-5xl font-bold truncate">{row.display_name}</span>
            <span className="laptime text-5xl font-bold">{formatLapTime(row.lap_time_ms)}</span>
            <span className="laptime text-3xl text-muted w-40 text-right">
              {index === 0 || !leader ? "" : formatGap(row.lap_time_ms - leader.lap_time_ms)}
            </span>
          </div>
        ))}
      </div>

      {interstitial && (
        <div className="grid-bg absolute inset-0 bg-bg/95 flex flex-col items-center justify-center gap-6 text-center">
          <p className="font-display text-accent text-glow font-black tracking-[0.3em] text-4xl uppercase">
            New personal best
          </p>
          <p className="font-display gradient-text text-8xl font-black">
            {interstitial.displayName}
          </p>
          <p className="laptime text-9xl font-black text-valid text-glow-subtle">
            {formatLapTime(interstitial.lapTimeMs)}
          </p>
          <p className="text-4xl text-muted">
            −{(interstitial.improvementMs / 1000).toFixed(3)} · now P{interstitial.rank}
          </p>
        </div>
      )}
    </main>
  );
}
