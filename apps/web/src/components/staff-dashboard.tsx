"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatLapTime } from "@/lib/time";
import { VENUE_TIMEZONE } from "@/lib/venue";
import { StaffLeaguePanel, type StaffLeagueProps } from "@/components/staff-league-panel";
import type { UnattributedLapRow } from "@/lib/unattributed-laps";

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

/**
 * Staff read these times against the venue clock and against a customer saying
 * "about nine". Pinned to the venue zone and an explicit locale rather than the
 * runtime default, which is UTC on the server and the browser's zone on the
 * tablet - so an unpinned format renders one time on first paint and a different
 * one after hydration.
 */
const unclaimedAt = new Intl.DateTimeFormat("en-US", {
  timeZone: VENUE_TIMEZONE,
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

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
  unattributedLaps,
  unattributedLapTotal,
  league,
}: {
  staffName: string;
  rigs: RigStatusRow[];
  laps: StaffLapRow[];
  unattributedLaps: UnattributedLapRow[];
  unattributedLapTotal: number;
  league: StaffLeagueProps;
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

      <StaffLeaguePanel {...league} />

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

      {unattributedLaps.length > 0 && (
        <section>
          <h2 className="text-muted font-bold uppercase tracking-wider text-sm mb-3">
            Unclaimed laps · last 7 days
          </h2>
          <p className="text-muted text-xs mb-3">
            Laps nobody can be credited with. They are kept but can never reach a
            leaderboard. Usually the customer drove before scanning the QR code -
            but a lap also lands here when the rig is on an agent build too old to
            say who was driving, when it names an assignment this rig has never
            owned, or when its finish time falls outside the assignment it does
            name (a drifted rig clock, or a rig offline while the seat changed
            hands). The lap itself does not carry which of the four it was. The
            three abnormal causes each leave a server log line naming which one;
            the ordinary drove-before-scanning case leaves none, because it is
            not an error.
          </p>
          <p className="text-muted text-xs mb-3">
            If a customer says their laps are missing, find them here by rig and
            time. If that customer was checked in, this was not their mistake and
            the rig needs looking at.
          </p>
          <div className="flex flex-col">
            {unattributedLaps.map((lap) => (
              <div
                key={lap.id}
                className="flex items-center gap-3 border-b border-edge py-2 text-sm opacity-60"
              >
                <span className="laptime font-bold w-20">
                  {formatLapTime(lap.lap_time_ms)}
                </span>
                <span className="text-muted w-32 truncate">
                  {unclaimedAt.format(new Date(lap.completed_at))}
                </span>
                <span className="text-muted w-12">
                  {lap.rig_number
                    ? `R${lap.rig_number.toString().padStart(2, "0")}`
                    : "—"}
                </span>
                <span className="text-muted flex-1 truncate">
                  {lap.track_name}
                  {lap.track_config ? ` (${lap.track_config})` : ""} · {lap.car_name}
                </span>
                <span className="text-invalid text-[10px] uppercase font-bold">
                  Unclaimed
                </span>
              </div>
            ))}
          </div>
          {unattributedLapTotal > unattributedLaps.length && (
            <p className="text-muted text-xs mt-3">
              Showing the {unattributedLaps.length} most recent of{" "}
              {unattributedLapTotal} unclaimed laps in the last 7 days. The rest
              are stored but not listed here.
            </p>
          )}
        </section>
      )}
    </main>
  );
}
