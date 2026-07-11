"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { browserClient } from "@/lib/supabase-browser";
import { formatLapTime, formatGap } from "@/lib/time";
import { venueToday } from "@/lib/venue";

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

/** Front-of-store leaderboard. Fixed-position rows animate to their new rank
 * (poor man's FLIP: absolute rows + translateY transitions). */
export default function TvPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [combo, setCombo] = useState<Combo | null>(null);
  const [interstitial, setInterstitial] = useState<Interstitial | null>(null);
  const previousBests = useRef<Map<string, number>>(new Map());
  const interstitialTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const db = browserClient();
    const { data } = await db
      .from("v_fastest_tonight")
      .select("driver_id, display_name, lap_time_ms")
      .order("lap_time_ms", { ascending: true })
      .limit(15);
    const next = (data ?? []) as Row[];

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
    const db = browserClient();
    void refresh();
    void db
      .from("featured_combos")
      .select("track_name, track_config, car_name")
      .eq("combo_date", venueToday())
      .maybeSingle()
      .then(({ data }) => setCombo((data as Combo | null) ?? null));

    const channel = db
      .channel("tv-laps")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "laps" },
        () => void refresh(),
      )
      .subscribe();

    // Belt and braces if the websocket drops (venue TVs run for hours).
    const poll = setInterval(() => void refresh(), 30_000);
    return () => {
      void db.removeChannel(channel);
      clearInterval(poll);
    };
  }, [refresh]);

  const leader = rows[0];

  return (
    <main className="flex-1 flex flex-col p-10 select-none overflow-hidden">
      <header className="flex items-end justify-between border-b-4 border-accent pb-4">
        <div>
          <h1 className="text-6xl font-black tracking-tight">FASTEST TONIGHT</h1>
          {combo && (
            <p className="text-muted text-2xl mt-1">
              {combo.track_name}
              {combo.track_config ? ` — ${combo.track_config}` : ""} ·{" "}
              {combo.car_name}
            </p>
          )}
        </div>
        <p className="text-accent font-bold tracking-[0.3em] text-xl uppercase pb-1">
          Oasis Live Timing
        </p>
      </header>

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
              className={`w-20 text-5xl font-black ${index === 0 ? "text-gold" : "text-muted"}`}
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
        <div className="absolute inset-0 bg-bg/95 flex flex-col items-center justify-center gap-6 text-center">
          <p className="text-accent font-black tracking-[0.3em] text-4xl uppercase">
            New personal best
          </p>
          <p className="text-8xl font-black">{interstitial.displayName}</p>
          <p className="laptime text-9xl font-black text-valid">
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
