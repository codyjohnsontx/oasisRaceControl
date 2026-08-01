"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { comboLabel, roundLabel, type LeagueRound } from "@/lib/league";
import { VENUE_TIMEZONE } from "@/lib/venue";

const REQUEST_TIMEOUT_MS = 10_000;

/** Server-side limits, mirrored so the form can't submit a value the API will
 *  reject (see the zod schema in api/staff/league/open-round). */
const MAX_NAME = 80;
const MAX_COMBO_FIELD = 120;

export type ComboOption = {
  track_name: string;
  track_config: string | null;
  car_name: string;
};

export type StaffLeagueProps = {
  seasonName: string | null;
  openRound: LeagueRound | null;
  /** Drivers already attributed to the open round. */
  openRoundDrivers: number;
  recentRounds: LeagueRound[];
  /** Combos seen in the lap history, offered as one-tap prefills. */
  comboOptions: ComboOption[];
  /** Tonight's featured combo, prefilled into the form. */
  todaysCombo: ComboOption | null;
};

/**
 * Running a league night, minimally: open a round against a combo, and close
 * it. Everything else (who is in it, who is winning) falls out of the laps the
 * rigs are already sending.
 */
export function StaffLeaguePanel({
  seasonName,
  openRound,
  openRoundDrivers,
  recentRounds,
  comboOptions,
  todaysCombo,
}: StaffLeagueProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [form, setForm] = useState({
    name: "",
    trackName: todaysCombo?.track_name ?? "",
    trackConfig: todaysCombo?.track_config ?? "",
    carName: todaysCombo?.car_name ?? "",
  });

  async function post(url: string, body: object) {
    setBusy(true);
    setError(null);
    // The venue tablet is on shop wifi; without a deadline a dropped request
    // leaves the button disabled with no explanation until staff reload.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        if (payload.error === "not_open") {
          // Someone else already closed it - the page is simply stale.
          setError("That round is already closed or no longer available.");
          router.refresh();
          return;
        }
        setError(
          payload.error === "round_already_open"
            ? "A round is already open. Close it first."
            : "That didn't go through - try again.",
        );
        return;
      }
      router.refresh();
    } catch (error) {
      setError(
        (error as Error)?.name === "AbortError"
          ? "Timed out - refresh to check whether it went through."
          : "Network problem - nothing was changed.",
      );
    } finally {
      clearTimeout(timeout);
      setBusy(false);
    }
  }

  function openRoundSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!form.trackName.trim() || !form.carName.trim()) {
      setError("Track and car are required.");
      return;
    }
    void post("/api/staff/league/open-round", {
      name: form.name.trim() || null,
      trackName: form.trackName.trim(),
      trackConfig: form.trackConfig.trim() || null,
      carName: form.carName.trim(),
      incidentLimit: 0,
    });
  }

  function closeRound() {
    if (!openRound) return;
    setConfirmingClose(false);
    void post("/api/staff/league/close-round", { roundId: openRound.id });
  }

  return (
    <section>
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="text-muted font-bold uppercase tracking-wider text-sm">
          League night{seasonName ? ` · ${seasonName}` : ""}
        </h2>
        <Link href="/league" className="text-muted text-xs underline underline-offset-4">
          Season standings
        </Link>
      </div>

      {error && (
        <p role="alert" className="text-invalid text-sm mb-3">
          {error}
        </p>
      )}

      {openRound ? (
        <div className="bg-surface border border-valid rounded-xl p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="flex items-center gap-2 font-bold">
              <span className="h-2 w-2 rounded-full bg-valid animate-pulse" aria-hidden />
              {roundLabel(openRound)} is open
            </p>
            <p className="text-muted text-sm truncate">{comboLabel(openRound)}</p>
            <p className="text-muted text-xs">
              {openRoundDrivers} {openRoundDrivers === 1 ? "driver" : "drivers"} so far ·
              {/* Venue time, not the tablet's - a device on the wrong zone
                  would otherwise report the round opening at the wrong hour. */}
              opened{" "}
              {new Date(openRound.opened_at).toLocaleTimeString("en-US", {
                timeZone: VENUE_TIMEZONE,
              })}
            </p>
          </div>
          {/* Two-tap confirm rather than window.confirm: a native dialog on the
              venue tablet blocks the whole page and reads like an error. */}
          <div className="flex items-center gap-2 shrink-0">
            <Link
              href={`/league/${openRound.id}`}
              className="text-xs font-bold uppercase tracking-wider border border-edge rounded-md px-3 py-2"
            >
              View field
            </Link>
            {confirmingClose ? (
              <>
                <button
                  type="button"
                  onClick={() => setConfirmingClose(false)}
                  className="text-xs font-bold uppercase tracking-wider border border-edge rounded-md px-3 py-2"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={closeRound}
                  className="text-xs font-bold uppercase tracking-wider bg-invalid text-bg rounded-md px-3 py-2 disabled:opacity-40"
                >
                  Confirm: results final
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmingClose(true)}
                className="text-xs font-bold uppercase tracking-wider text-invalid border border-invalid rounded-md px-3 py-2 disabled:opacity-40"
              >
                Close round
              </button>
            )}
          </div>
        </div>
      ) : (
        <form
          onSubmit={openRoundSubmit}
          className="bg-surface border border-edge rounded-xl p-4 flex flex-col gap-3"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted text-xs uppercase tracking-wider">Round name</span>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                maxLength={MAX_NAME}
                placeholder="Week 3 (optional)"
                className="bg-bg border border-edge rounded-lg px-3 py-2"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted text-xs uppercase tracking-wider">Car</span>
              <input
                required
                value={form.carName}
                onChange={(e) => setForm({ ...form, carName: e.target.value })}
                maxLength={MAX_COMBO_FIELD}
                list="league-cars"
                className="bg-bg border border-edge rounded-lg px-3 py-2"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted text-xs uppercase tracking-wider">Track</span>
              <input
                required
                value={form.trackName}
                onChange={(e) => setForm({ ...form, trackName: e.target.value })}
                maxLength={MAX_COMBO_FIELD}
                list="league-tracks"
                className="bg-bg border border-edge rounded-lg px-3 py-2"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted text-xs uppercase tracking-wider">Layout</span>
              <input
                value={form.trackConfig}
                onChange={(e) => setForm({ ...form, trackConfig: e.target.value })}
                maxLength={MAX_COMBO_FIELD}
                list="league-configs"
                placeholder="optional"
                className="bg-bg border border-edge rounded-lg px-3 py-2"
              />
            </label>
          </div>

          <datalist id="league-tracks">
            {[...new Set(comboOptions.map((c) => c.track_name))].map((track) => (
              <option key={track} value={track} />
            ))}
          </datalist>
          <datalist id="league-configs">
            {[...new Set(comboOptions.map((c) => c.track_config).filter(Boolean))].map(
              (config) => (
                <option key={config as string} value={config as string} />
              ),
            )}
          </datalist>
          <datalist id="league-cars">
            {[...new Set(comboOptions.map((c) => c.car_name))].map((car) => (
              <option key={car} value={car} />
            ))}
          </datalist>

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-muted text-xs max-w-md">
              Opening a round also makes this tonight&apos;s featured combo, so clean
              laps on it count; closing the round puts the previous combo back. Laps
              already logged today keep their current validity.
            </p>
            <button
              type="submit"
              disabled={busy}
              className="bg-accent text-bg font-bold uppercase tracking-wider text-sm rounded-lg px-5 py-2.5 disabled:opacity-40"
            >
              Open round
            </button>
          </div>
        </form>
      )}

      {recentRounds.length > 0 && (
        <ul className="flex flex-wrap gap-2 mt-3">
          {recentRounds.map((round) => (
            <li key={round.id}>
              <Link
                href={`/league/${round.id}`}
                className="flex items-center gap-2 rounded-lg border border-edge bg-surface px-3 py-1.5 text-xs"
              >
                <span className="font-bold">{roundLabel(round)}</span>
                <span className="text-muted">{round.round_date}</span>
                {round.closed_at === null && (
                  <span className="text-valid font-bold uppercase tracking-wider">live</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
