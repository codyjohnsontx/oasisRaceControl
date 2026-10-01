"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RIG_HEALTH_REFRESH_MS } from "@/lib/monitor/refresh";
import type { Problem, RigTile, TileColour } from "@/lib/monitor/rig-health";
import type { Severity } from "@/lib/monitor/rules";

export type RigHealthAlert = {
  id: string;
  severity: Severity;
  rule: string;
  where: string;
  headline: string;
  opened: string;
  recovered: string | null;
  /** Flapping: kept here, not posted, for the hour. */
  muted: boolean;
  issue: { number: number; href: string } | null;
};

export type RigHealthBoard = {
  id: string;
  name: string;
  state: "live" | "dark" | "closed";
  detail: string;
};

type Notice = { ok: boolean; text: string; area: "event" | "monitor" };

const TILE_BORDER: Record<TileColour, string> = {
  red: "border-invalid",
  yellow: "border-gold",
  green: "border-valid",
  grey: "border-edge",
};

const TILE_TEXT: Record<TileColour, string> = {
  red: "text-invalid",
  yellow: "text-gold",
  green: "text-valid",
  grey: "text-muted",
};

/** The data-flow view's dots, in rig-flow.tsx's colours. */
const LEGEND: Array<[colour: string, label: string, small?: boolean]> = [
  ["accent", "heartbeat", true],
  ["valid", "lap that ranks"],
  ["sunset", "invalid lap"],
  ["purple", "lap with nobody signed in"],
  ["gold", "queued on the rig"],
  ["invalid", "refused by the site"],
];

function severityText(severity: Severity): string {
  return severity === "urgent" ? "text-invalid" : "text-gold";
}

export function StaffRigHealth({
  staffName,
  flow,
  tiles,
  venueProblems,
  event,
  boards,
  checks,
  alerts,
}: {
  staffName: string;
  /** The data-flow view, rendered on the server; null when there are no rigs. */
  flow: ReactNode;
  tiles: RigTile[];
  venueProblems: Problem[];
  event: { on: boolean; line: string; override: "on" | "off" | null };
  boards: RigHealthBoard[];
  checks: string;
  alerts: RigHealthAlert[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  // The same 15 s cadence as the staff dashboard.
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), RIG_HEALTH_REFRESH_MS);
    return () => clearInterval(timer);
  }, [router]);

  async function post(
    key: string,
    url: string,
    body: object,
    area: Notice["area"],
    describe: (res: Response, json: Record<string, unknown>) => Omit<Notice, "area">,
  ) {
    setBusy(key);
    setNotice(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      setNotice({ ...describe(res, json), area });
      router.refresh();
    } catch {
      setNotice({ ok: false, text: "Network problem - nothing was sent.", area });
    } finally {
      setBusy(null);
    }
  }

  function setEventMode(mode: "on" | "off" | "auto") {
    void post(`mode-${mode}`, "/api/staff/event-mode", { mode }, "event", (res) =>
      res.ok
        ? {
            ok: true,
            text:
              mode === "auto"
                ? "Event mode follows the TV boards again."
                : `Event mode ${mode} until midnight.`,
          }
        : { ok: false, text: `Event mode was not changed (HTTP ${res.status}).` },
    );
  }

  function sendTest() {
    void post("test", "/api/staff/monitor/test-message", {}, "monitor", (res, json) => {
      if (json.status === "sent") return { ok: true, text: "Test message sent - check the Discord channel." };
      if (json.status === "not_configured") {
        return { ok: false, text: "Not sent: this deployment has no DISCORD_WEBHOOK_URL." };
      }
      if (json.status === "failed") return { ok: false, text: `Discord refused it: ${String(json.reason)}` };
      return { ok: false, text: `Not sent (HTTP ${res.status}).` };
    });
  }

  function runChecks() {
    void post("run", "/api/staff/monitor/run", {}, "monitor", (res, json) => {
      if (!res.ok) return { ok: false, text: `Checks did not run (HTTP ${res.status}).` };
      if (json.evaluated === false) {
        return { ok: true, text: "Checks ran moments ago - the page shows their result." };
      }
      return {
        ok: true,
        text: `Checks ran: ${Number(json.findings)} found, ${Number(json.announced)} posted, ${Number(
          json.recovered,
        )} recovered.`,
      };
    });
  }

  const modeButton = (mode: "on" | "off" | "auto", label: string, active: boolean) => (
    <button
      type="button"
      disabled={busy !== null}
      aria-pressed={active}
      onClick={() => setEventMode(mode)}
      className={`text-xs font-bold uppercase tracking-wider border rounded-md px-3 py-2 disabled:opacity-40 ${
        active ? "border-accent text-accent" : "border-edge"
      }`}
    >
      {label}
    </button>
  );

  return (
    // Below xl the floating Screens button reaches over the header's right end,
    // so the page starts under it - as the staff dashboard does.
    <main className="flex-1 flex flex-col gap-8 p-6 pt-20 xl:pt-6 max-w-5xl w-full mx-auto">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-black">Rig health</h1>
        <div className="flex items-center gap-4">
          <Link href="/staff" className="text-muted text-sm underline underline-offset-4">
            Staff
          </Link>
          <p className="text-muted text-sm">{staffName}</p>
        </div>
      </header>

      {venueProblems.length > 0 && (
        <section>
          <h2 className="text-muted font-bold uppercase tracking-wider text-sm mb-3">Venue</h2>
          <ul className="flex flex-col gap-1">
            {venueProblems.map((p) => (
              <li key={p.headline} className={`text-sm ${severityText(p.severity)}`}>
                {p.headline}
              </li>
            ))}
          </ul>
        </section>
      )}

      {flow && (
        // One card, title and legend inside its padding: this panel is the
        // picture people share, so nothing in it sits flush with its edge.
        <section className="bg-surface border border-edge rounded-xl p-4 flex flex-col gap-3">
          <h2 className="text-muted font-bold uppercase tracking-wider text-sm">Data flow</h2>
          <div className="overflow-x-auto">
            {flow}
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-muted text-xs">
            {LEGEND.map(([colour, label, small]) => (
              <li key={label} className="flex items-center gap-1.5">
                <span
                  className={`inline-block shrink-0 rounded-full ${small ? "size-1.5" : "size-2.5"}`}
                  style={{ background: `var(--${colour})` }}
                />
                {label}
              </li>
            ))}
            <li>Last 10 minutes: the further along, the older</li>
          </ul>
        </section>
      )}

      <section>
        <h2 className="text-muted font-bold uppercase tracking-wider text-sm mb-3">Rigs</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {tiles.map((tile) => (
            <div
              key={tile.id}
              data-colour={tile.colour}
              className={`bg-surface border rounded-xl p-3 flex flex-col gap-1 min-w-0 ${TILE_BORDER[tile.colour]}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-black">{tile.label}</span>
                <span className={`text-[10px] font-bold uppercase ${TILE_TEXT[tile.colour]}`}>
                  {tile.status}
                </span>
              </div>
              {tile.problems.map((p) => (
                <p key={p.headline} className={`text-xs ${severityText(p.severity)}`}>
                  {p.headline}
                </p>
              ))}
              <p className="text-sm truncate">
                {tile.driver ?? <span className="text-muted">Available</span>}
              </p>
              <p className="text-muted text-xs break-words">{tile.iracing}</p>
              <p className="text-muted text-xs">{tile.lastLap}</p>
              <p className="text-muted text-xs">{tile.queue}</p>
              <p className="text-muted text-[10px]">
                {tile.agent}
                {tile.oldAgent && (
                  <span className="ml-1 font-bold uppercase text-gold">old agent</span>
                )}
                {tile.outdated && !tile.oldAgent && (
                  <span className="ml-1 font-bold uppercase text-gold">outdated</span>
                )}
              </p>
              {tile.footprint && <p className="text-muted text-[10px]">{tile.footprint}</p>}
              {tile.clockSkew && <p className="text-muted text-[10px]">{tile.clockSkew}</p>}
              <p className="text-muted text-[10px]">{tile.heartbeat}</p>
            </div>
          ))}
        </div>
        {tiles.length === 0 && <p className="text-muted text-sm">No rigs registered.</p>}
      </section>

      <section>
        <h2 className="text-muted font-bold uppercase tracking-wider text-sm mb-3">Event mode</h2>
        <div className="bg-surface border border-edge rounded-xl p-4 flex flex-col gap-3">
          <p className="text-sm">
            <span className={`font-bold uppercase ${event.on ? "text-valid" : "text-muted"}`}>
              {event.on ? "On" : "Off"}
            </span>{" "}
            <span className="text-muted">{event.line}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            {modeButton("on", "Start event", event.override === "on")}
            {modeButton("off", "Stop event", event.override === "off")}
            {modeButton("auto", "Auto", event.override === null)}
          </div>
          {notice?.area === "event" && <NoticeLine notice={notice} />}
          {boards.length > 0 && (
            <ul className="flex flex-col gap-1 text-xs">
              {boards.map((b) => (
                <li key={b.id} className="flex gap-2">
                  <span>{b.name}</span>
                  <span
                    className={`font-bold uppercase ${
                      b.state === "live" ? "text-valid" : b.state === "dark" ? "text-invalid" : "text-muted"
                    }`}
                  >
                    {b.state}
                  </span>
                  <span className="text-muted">{b.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-muted font-bold uppercase tracking-wider text-sm mb-3">Monitor</h2>
        <div className="flex flex-col gap-3">
          <p className="text-muted text-sm">{checks}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={runChecks}
              className="text-xs font-bold uppercase tracking-wider border border-edge rounded-md px-3 py-2 disabled:opacity-40"
            >
              Run checks now
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={sendTest}
              className="text-xs font-bold uppercase tracking-wider border border-edge rounded-md px-3 py-2 disabled:opacity-40"
            >
              Send test message to Discord
            </button>
          </div>
          {notice?.area === "monitor" && <NoticeLine notice={notice} />}
        </div>
      </section>

      <section>
        <h2 className="text-muted font-bold uppercase tracking-wider text-sm mb-3">Alerts</h2>
        <div className="flex flex-col">
          {alerts.map((a) => (
            <div key={a.id} className="border-b border-edge py-2 text-sm flex flex-col gap-0.5">
              <div className="flex items-baseline gap-2">
                <span className={`w-14 shrink-0 text-[10px] font-bold uppercase ${severityText(a.severity)}`}>
                  {a.severity}
                </span>
                <span className="flex-1 min-w-0">{a.headline}</span>
              </div>
              <p className="text-muted text-xs pl-16">
                {a.rule} · {a.where} · opened {a.opened} ·{" "}
                {a.recovered ? (
                  `recovered ${a.recovered}`
                ) : (
                  <span className="font-bold uppercase text-ink">open</span>
                )}
                {a.muted && " · muted (flapping)"}
                {a.issue !== null && (
                  <>
                    {" · "}
                    <a href={a.issue.href} className="underline underline-offset-4">
                      issue #{a.issue.number}
                    </a>
                  </>
                )}
              </p>
            </div>
          ))}
          {alerts.length === 0 && <p className="text-muted text-sm">No alerts yet.</p>}
        </div>
      </section>
    </main>
  );
}

function NoticeLine({ notice }: { notice: Notice }) {
  return (
    <p role="status" className={`text-sm ${notice.ok ? "text-valid" : "text-invalid"}`}>
      {notice.text}
    </p>
  );
}
