"use client";

import { useState } from "react";
import type { StaffDriverMatch } from "@/app/api/staff/drivers/route";
import { VENUE_TIMEZONE } from "@/lib/venue";

const REQUEST_TIMEOUT_MS = 10_000;

const ERROR_MESSAGES = new Map([
  ["pins_do_not_match", "The two PINs don't match - type them again."],
  ["invalid_input", "The PIN must be exactly 4 digits."],
  ["not_found", "That racer no longer exists - search again."],
  ["forbidden", "Your staff sign-in has expired - sign in again."],
  ["cross_origin", "The reset was refused as not coming from this page - reload and try again."],
  ["unsupported_media_type", "The reset was refused as not coming from this page - reload and try again."],
]);

type Outcome = { tone: "ok" | "error"; text: string } | null;

/** A racer picked from somewhere other than this panel's own search. */
export type PinResetTarget = Pick<StaffDriverMatch, "id" | "display_name">;

function lapSummary(driver: StaffDriverMatch): string {
  if (driver.lap_count === 0) return "no laps";
  const laps = driver.lap_count === 1 ? "1 lap" : `${driver.lap_count} laps`;
  if (!driver.last_lap_at) return laps;
  const last = new Date(driver.last_lap_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: VENUE_TIMEZONE,
  });
  return `${laps}, last ${last}`;
}

async function request(url: string, init?: RequestInit): Promise<Response> {
  // The venue tablet is on shop wifi; without a deadline a dropped request
  // leaves the form disabled with no explanation until staff reload.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function failureText(error: unknown): string {
  return (error as Error)?.name === "AbortError"
    ? "Timed out - search again to check whether it went through."
    : "Network problem - nothing was changed.";
}

/**
 * A returning racer who cannot sign in because the PIN on file does not match.
 * Staff find them by name, or tap their name under Recent laps (`driver`), and
 * give them a new PIN, typed twice. The driver row is updated in place, so
 * their laps stay theirs, and the route writes an audit_log row naming the
 * staff member.
 */
export function StaffPinReset({ driver = null }: { driver?: PinResetTarget | null }) {
  const [name, setName] = useState("");
  const [matches, setMatches] = useState<StaffDriverMatch[] | null>(null);
  const [selected, setSelected] = useState<PinResetTarget | StaffDriverMatch | null>(driver);
  const [pin, setPin] = useState({ newPin: "", confirmPin: "" });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  async function search(event: React.FormEvent) {
    event.preventDefault();
    const query = name.trim();
    if (!query) return;
    setBusy(true);
    setOutcome(null);
    setSelected(null);
    try {
      const res = await request(`/api/staff/drivers?name=${encodeURIComponent(query)}`);
      const payload = (await res.json().catch(() => ({}))) as {
        drivers?: StaffDriverMatch[];
        error?: string;
      };
      if (!res.ok || !payload.drivers) {
        setMatches(null);
        setOutcome({
          tone: "error",
          text: ERROR_MESSAGES.get(payload.error ?? "") ?? "Search didn't go through - try again.",
        });
        return;
      }
      setMatches(payload.drivers);
    } catch (error) {
      setOutcome({ tone: "error", text: failureText(error) });
    } finally {
      setBusy(false);
    }
  }

  function choose(driver: StaffDriverMatch) {
    setSelected(driver);
    setPin({ newPin: "", confirmPin: "" });
    setOutcome(null);
  }

  async function reset(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    if (!/^\d{4}$/.test(pin.newPin)) {
      setOutcome({ tone: "error", text: "The PIN must be exactly 4 digits." });
      return;
    }
    if (pin.newPin !== pin.confirmPin) {
      setOutcome({ tone: "error", text: ERROR_MESSAGES.get("pins_do_not_match")! });
      return;
    }
    setBusy(true);
    setOutcome(null);
    try {
      const res = await request("/api/staff/reset-pin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ driverId: selected.id, ...pin }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        setOutcome({
          tone: "error",
          text: ERROR_MESSAGES.get(payload.error ?? "") ?? "That didn't go through - try again.",
        });
        return;
      }
      setOutcome({
        tone: "ok",
        text: `PIN reset for ${selected.display_name}. They can sign in with the new PIN now, and their laps are unchanged.`,
      });
      setSelected(null);
      setMatches(null);
      setName("");
      setPin({ newPin: "", confirmPin: "" });
    } catch (error) {
      setOutcome({ tone: "error", text: failureText(error) });
    } finally {
      setBusy(false);
    }
  }

  const pinInput = {
    type: "password",
    inputMode: "numeric",
    pattern: "\\d{4}",
    maxLength: 4,
    autoComplete: "off",
    required: true,
    className: "bg-bg border border-edge rounded-lg px-3 py-2 w-28 tracking-[0.4em]",
  } as const;

  return (
    <section>
      <h2 className="text-muted font-bold uppercase tracking-wider text-sm mb-3">
        Reset a racer&apos;s PIN
      </h2>
      <div className="bg-surface border border-edge rounded-xl p-4 flex flex-col gap-3">
        <form onSubmit={search} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm flex-1 min-w-48">
            <span className="text-muted text-xs uppercase tracking-wider">Racer name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={24}
              autoComplete="off"
              placeholder="The name they signed up with"
              className="bg-bg border border-edge rounded-lg px-3 py-2"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="text-xs font-bold uppercase tracking-wider border border-edge rounded-md px-4 py-2.5 disabled:opacity-40"
          >
            Find
          </button>
        </form>

        {matches && matches.length === 0 && (
          <p className="text-muted text-sm">No racer with a name like that.</p>
        )}

        {matches && matches.length > 0 && !selected && (
          <ul className="flex flex-col">
            {matches.map((driver) => (
              <li
                key={driver.id}
                className="flex items-center gap-3 border-b border-edge py-2 text-sm last:border-b-0"
              >
                <span className="font-bold truncate">{driver.display_name}</span>
                <span className="text-muted text-xs flex-1 truncate">{lapSummary(driver)}</span>
                {driver.is_guest && (
                  <span className="text-muted text-[10px] uppercase font-bold">guest</span>
                )}
                {driver.locked_until && (
                  <span className="text-invalid text-[10px] uppercase font-bold">locked out</span>
                )}
                {driver.status !== "active" && (
                  <span className="text-invalid text-[10px] uppercase font-bold">
                    {driver.status}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => choose(driver)}
                  className="text-xs font-bold uppercase tracking-wider border border-edge rounded-md px-2 py-1"
                >
                  Reset PIN
                </button>
              </li>
            ))}
          </ul>
        )}

        {selected && (
          <form onSubmit={reset} className="flex flex-col gap-3">
            <p className="text-sm">
              New PIN for <span className="font-bold">{selected.display_name}</span>
              {"lap_count" in selected && (
                <span className="text-muted"> ({lapSummary(selected)})</span>
              )}
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted text-xs uppercase tracking-wider">New PIN</span>
                <input
                  {...pinInput}
                  autoFocus
                  value={pin.newPin}
                  onChange={(event) => setPin({ ...pin, newPin: event.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted text-xs uppercase tracking-wider">Type it again</span>
                <input
                  {...pinInput}
                  value={pin.confirmPin}
                  onChange={(event) => setPin({ ...pin, confirmPin: event.target.value })}
                />
              </label>
              <button
                type="submit"
                disabled={busy}
                className="bg-accent text-bg font-bold uppercase tracking-wider text-sm rounded-lg px-5 py-2.5 disabled:opacity-40"
              >
                Set PIN
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setSelected(null)}
                className="text-muted text-xs underline underline-offset-4 disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {outcome && (
          <p
            role={outcome.tone === "error" ? "alert" : "status"}
            className={`text-sm ${outcome.tone === "error" ? "text-invalid" : "text-valid"}`}
          >
            {outcome.text}
          </p>
        )}
      </div>
    </section>
  );
}
