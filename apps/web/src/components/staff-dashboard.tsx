"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatLapTime } from "@/lib/time";

export type RigStatusRow = {
  rig_id: string;
  rig_number: number;
  display_name: string;
  agent_version: string | null;
  last_seen_at: string | null;
  assignment_id: string | null;
  assignment_started_at: string | null;
  driver_id: string | null;
  driver_name: string | null;
};

export type StaffLapRow = {
  id: string;
  lap_time_ms: number;
  is_valid: boolean;
  invalid_reason: string | null;
  track_name: string;
  car_name: string;
  completed_at: string;
  driver_id: string;
  driver_name: string;
  rig_number: number | null;
};

const AGENT_ONLINE_WINDOW_MS = 90_000;

function agentStatus(lastSeenAt: string | null): "online" | "offline" {
  if (!lastSeenAt) return "offline";
  return Date.now() - new Date(lastSeenAt).getTime() < AGENT_ONLINE_WINDOW_MS
    ? "online"
    : "offline";
}

export function StaffDashboard({
  staffName,
  rigs,
  laps,
}: {
  staffName: string;
  rigs: RigStatusRow[];
  laps: StaffLapRow[];
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  // Rig freshness matters at a glance; refresh the server data every 15s.
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(timer);
  }, [router]);

  async function post(url: string, body: object, busyKey: string) {
    setBusyId(busyKey);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        window.alert("That didn't go through — check the connection and try again.");
        return;
      }
      router.refresh();
    } catch {
      window.alert("Network problem — the action was not applied.");
    } finally {
      setBusyId(null);
    }
  }

  function clearRig(rig: RigStatusRow) {
    const reason = window.prompt(`Clear ${rig.driver_name} off Rig ${rig.rig_number}? Reason:`);
    if (!reason?.trim()) return;
    void post("/api/staff/clear-rig", { rigId: rig.rig_id, reason }, rig.rig_id);
  }

  function toggleLap(lap: StaffLapRow) {
    const action = lap.is_valid ? "invalidate" : "restore";
    const reason = window.prompt(`${action} this ${formatLapTime(lap.lap_time_ms)} lap by ${lap.driver_name}? Reason:`);
    if (!reason) return;
    void post("/api/staff/lap-validity", { lapId: lap.id, action, reason }, lap.id);
  }

  function resetPin(driverId: string, driverName: string) {
    const newPin = window.prompt(`New 4-digit PIN for ${driverName}:`);
    if (!newPin) return;
    if (!/^\d{4}$/.test(newPin)) {
      window.alert("PIN must be exactly 4 digits");
      return;
    }
    void post("/api/staff/reset-pin", { driverId, newPin }, driverId);
  }

  return (
    <main className="flex-1 flex flex-col gap-8 p-6 max-w-5xl w-full mx-auto">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-black">Race Control — Staff</h1>
        <div className="flex items-center gap-4">
          <Link
            href="/leaderboards"
            className="text-muted text-sm underline underline-offset-4"
          >
            Leaderboards
          </Link>
          <p className="text-muted text-sm">{staffName}</p>
        </div>
      </header>

      <section>
        <h2 className="text-muted font-bold uppercase tracking-wider text-sm mb-3">Rigs</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {rigs.map((rig) => {
            const online = agentStatus(rig.last_seen_at) === "online";
            return (
              <div
                key={rig.rig_id}
                className={`bg-surface border rounded-xl p-3 flex flex-col gap-1 ${
                  online ? "border-edge" : "border-invalid"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-black">R{rig.rig_number.toString().padStart(2, "0")}</span>
                  <span
                    className={`text-[10px] font-bold uppercase ${
                      online ? "text-valid" : "text-invalid"
                    }`}
                  >
                    {online ? "online" : "agent offline"}
                  </span>
                </div>
                <p className="text-sm truncate">
                  {rig.driver_name ?? <span className="text-muted">Available</span>}
                </p>
                <p className="text-muted text-[10px]">
                  {rig.agent_version ?? "no agent"}
                </p>
                {rig.assignment_id && (
                  <button
                    type="button"
                    disabled={busyId === rig.rig_id}
                    onClick={() => clearRig(rig)}
                    className="mt-1 text-xs font-bold uppercase tracking-wider text-invalid border border-invalid rounded-md py-1 disabled:opacity-40"
                  >
                    Clear
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="text-muted font-bold uppercase tracking-wider text-sm mb-3">
          Recent laps
        </h2>
        <div className="flex flex-col">
          {laps.map((lap) => (
            <div
              key={lap.id}
              className={`flex items-center gap-3 border-b border-edge py-2 text-sm ${
                lap.is_valid ? "" : "opacity-60"
              }`}
            >
              <span className="laptime font-bold w-20">{formatLapTime(lap.lap_time_ms)}</span>
              <button
                type="button"
                disabled={busyId === lap.driver_id}
                onClick={() => resetPin(lap.driver_id, lap.driver_name)}
                title="Reset PIN"
                className="w-32 truncate text-left underline decoration-dotted underline-offset-4 disabled:opacity-40"
              >
                {lap.driver_name}
              </button>
              <span className="text-muted w-12">
                {lap.rig_number ? `R${lap.rig_number.toString().padStart(2, "0")}` : "—"}
              </span>
              <span className="text-muted flex-1 truncate">
                {lap.track_name} · {lap.car_name}
              </span>
              {!lap.is_valid && (
                <span className="text-invalid text-[10px] uppercase font-bold">
                  {lap.invalid_reason}
                </span>
              )}
              <button
                type="button"
                disabled={busyId === lap.id}
                onClick={() => toggleLap(lap)}
                className="text-xs font-bold uppercase tracking-wider border border-edge rounded-md px-2 py-1 disabled:opacity-40"
              >
                {lap.is_valid ? "Invalidate" : "Restore"}
              </button>
            </div>
          ))}
          {laps.length === 0 && <p className="text-muted text-sm">No laps yet.</p>}
        </div>
        <p className="text-muted text-xs mt-2">
          Tip: tap a driver&apos;s name to reset their PIN.
        </p>
      </section>
    </main>
  );
}
