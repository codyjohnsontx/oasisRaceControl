"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase-browser";
import { formatLapTime } from "@/lib/time";

export type PortalLap = {
  id: string;
  track_name: string;
  track_config: string | null;
  car_name: string;
  lap_number: number | null;
  lap_time_ms: number;
  is_valid: boolean;
  invalid_reason: string | null;
  completed_at: string;
};

type Props = {
  driverId: string;
  displayName: string;
  isGuest: boolean;
  activeRigNumber: number | null;
  initialLaps: PortalLap[];
};

export function Portal({ driverId, displayName, isGuest, activeRigNumber, initialLaps }: Props) {
  const router = useRouter();
  const [laps, setLaps] = useState<PortalLap[]>(initialLaps);
  const [trackFilter, setTrackFilter] = useState("");
  const [carFilter, setCarFilter] = useState("");
  const [pin, setPin] = useState("");
  const [claimState, setClaimState] = useState<"idle" | "busy" | "done">("idle");

  // Live laps: new inserts for this driver appear as they're captured.
  useEffect(() => {
    const db = browserClient();
    const channel = db
      .channel(`laps-${driverId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "laps",
          filter: `driver_id=eq.${driverId}`,
        },
        (payload) => {
          const lap = payload.new as PortalLap;
          setLaps((current) =>
            current.some((l) => l.id === lap.id) ? current : [lap, ...current],
          );
        },
      )
      .subscribe();
    return () => void db.removeChannel(channel);
  }, [driverId]);

  const tracks = useMemo(
    () => [...new Set(laps.map((l) => l.track_name))].sort(),
    [laps],
  );
  const cars = useMemo(() => [...new Set(laps.map((l) => l.car_name))].sort(), [laps]);

  const filtered = useMemo(
    () =>
      laps.filter(
        (l) =>
          (!trackFilter || l.track_name === trackFilter) &&
          (!carFilter || l.car_name === carFilter),
      ),
    [laps, trackFilter, carFilter],
  );

  // Personal bests: best valid lap per track+config+car combo.
  const personalBests = useMemo(() => {
    const bests = new Map<string, PortalLap>();
    for (const lap of filtered) {
      if (!lap.is_valid) continue;
      const key = `${lap.track_name}|${lap.track_config ?? ""}|${lap.car_name}`;
      const existing = bests.get(key);
      if (!existing || lap.lap_time_ms < existing.lap_time_ms) bests.set(key, lap);
    }
    return [...bests.values()].sort((a, b) => a.track_name.localeCompare(b.track_name));
  }, [filtered]);

  async function endSession() {
    try {
      await fetch("/api/session/end", { method: "POST" });
    } catch {
      // Refresh anyway — the server state is what matters and will re-render.
    }
    router.refresh();
  }

  async function claim() {
    setClaimState("busy");
    try {
      const res = await fetch("/api/auth/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      setClaimState(res.ok ? "done" : "idle");
      if (res.ok) router.refresh();
    } catch {
      setClaimState("idle");
    }
  }

  return (
    <main className="flex-1 flex flex-col gap-6 p-5 max-w-2xl w-full mx-auto">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black">{displayName}</h1>
          {activeRigNumber !== null ? (
            <p className="text-valid text-sm font-semibold">
              On Rig {activeRigNumber.toString().padStart(2, "0")}
            </p>
          ) : (
            <p className="text-muted text-sm">Not checked in — scan a rig QR to drive</p>
          )}
        </div>
        {activeRigNumber !== null && (
          <button
            type="button"
            onClick={() => void endSession()}
            className="bg-surface border border-edge rounded-lg px-4 py-2 text-sm font-bold uppercase tracking-wider"
          >
            End session
          </button>
        )}
      </header>

      {isGuest && claimState !== "done" && (
        <section className="bg-surface border border-accent rounded-xl p-4">
          <p className="font-bold">Keep tonight&apos;s results</p>
          <p className="text-muted text-sm mt-1">
            Set a 4-digit PIN and “{displayName}” becomes your permanent driver
            profile — laps included.
          </p>
          <div className="flex gap-2 mt-3">
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder="4-digit PIN"
              inputMode="numeric"
              className="laptime flex-1 bg-bg border border-edge rounded-lg px-3 py-2 outline-none focus:border-accent"
            />
            <button
              type="button"
              disabled={pin.length !== 4 || claimState === "busy"}
              onClick={() => void claim()}
              className="bg-accent rounded-lg px-4 py-2 font-bold uppercase tracking-wider text-sm disabled:opacity-40"
            >
              Save profile
            </button>
          </div>
        </section>
      )}

      {(tracks.length > 1 || cars.length > 1) && (
        <section className="flex gap-2">
          <select
            value={trackFilter}
            onChange={(e) => setTrackFilter(e.target.value)}
            className="flex-1 bg-surface border border-edge rounded-lg px-3 py-2 text-sm"
          >
            <option value="">All tracks</option>
            {tracks.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <select
            value={carFilter}
            onChange={(e) => setCarFilter(e.target.value)}
            className="flex-1 bg-surface border border-edge rounded-lg px-3 py-2 text-sm"
          >
            <option value="">All cars</option>
            {cars.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </section>
      )}

      {personalBests.length > 0 && (
        <section>
          <h2 className="text-muted font-bold uppercase tracking-wider text-sm mb-2">
            Personal bests
          </h2>
          <div className="flex flex-col gap-2">
            {personalBests.map((lap) => (
              <div
                key={lap.id}
                className="flex items-center justify-between bg-surface border border-edge rounded-xl px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="font-bold truncate">{lap.track_name}</p>
                  <p className="text-muted text-xs truncate">
                    {lap.track_config ? `${lap.track_config} · ` : ""}
                    {lap.car_name}
                  </p>
                </div>
                <span className="laptime text-xl font-bold text-gold">
                  {formatLapTime(lap.lap_time_ms)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="flex-1">
        <h2 className="text-muted font-bold uppercase tracking-wider text-sm mb-2">
          Laps
        </h2>
        {filtered.length === 0 ? (
          <p className="text-muted text-sm">
            No laps yet — they&apos;ll appear here seconds after you cross the line.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {filtered.map((lap) => (
              <div
                key={lap.id}
                className={`flex items-center gap-3 border-b border-edge px-1 py-2 ${
                  lap.is_valid ? "" : "opacity-50"
                }`}
              >
                <span className="laptime text-lg font-bold w-24">
                  {formatLapTime(lap.lap_time_ms)}
                </span>
                <span className="text-muted text-xs flex-1 truncate">
                  {lap.track_name}
                  {lap.track_config ? ` (${lap.track_config})` : ""} · {lap.car_name}
                </span>
                {lap.is_valid ? (
                  <span className="text-valid text-xs font-bold">✓</span>
                ) : (
                  <span
                    className="text-invalid text-xs font-bold uppercase"
                    title={lap.invalid_reason ?? ""}
                  >
                    invalid
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <footer className="flex justify-center pb-2">
        <button
          type="button"
          onClick={async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            router.refresh();
          }}
          className="text-muted text-sm underline underline-offset-4"
        >
          Sign out
        </button>
      </footer>
    </main>
  );
}
