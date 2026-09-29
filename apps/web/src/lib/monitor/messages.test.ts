import { describe, expect, it } from "vitest";
import {
  alertMessage,
  eventModeLine,
  monitorGapLine,
  noteMessage,
  recoveryMessage,
  routineUpdateMessage,
  type AlertForMessage,
} from "./messages";
import type { Heartbeat } from "./rig-state";
import type { MonitorSnapshot, RigSnapshot } from "./rules";
import type { RoutineFacts } from "./store";

const OPENED = Date.parse("2026-10-04T21:00:00Z");

const URGENT: AlertForMessage = {
  id: "123",
  rule: "rig_silent",
  severity: "urgent",
  openedAt: OPENED,
  resolvedAt: null,
  detail: {
    headline: "Rig 02 has been silent for 2 min with Matt G signed in",
    where: "Rig 02",
    fields: [
      { name: "Driver", value: "Matt G (seated 18 min)" },
      { name: "Last heard", value: "2 min ago" },
      { name: "Agent", value: "rig-agent/0.4-monitor" },
    ],
  },
};

const OWNER = "123456789012345678";

describe("alertMessage", () => {
  it("mentions the owner on an urgent alert, and allows exactly that mention", () => {
    const message = alertMessage(URGENT, OWNER);
    expect(message.content).toBe(`<@${OWNER}> 🔴 Rig 02 has been silent for 2 min with Matt G signed in`);
    expect(message.allowed_mentions).toEqual({ parse: [], users: [OWNER] });
    expect(message.embeds).toEqual([
      {
        title: "Rig silent",
        color: 0xe74c3c,
        fields: [
          { name: "Where", value: "Rig 02", inline: true },
          { name: "Driver", value: "Matt G (seated 18 min)", inline: true },
          { name: "Last heard", value: "2 min ago", inline: true },
          { name: "Agent", value: "rig-agent/0.4-monitor", inline: true },
        ],
        footer: { text: "alert #123 · rule 1" },
      },
    ]);
  });

  it("posts an urgent alert without a mention when no owner id is configured", () => {
    const message = alertMessage(URGENT, null);
    expect(message.content).toBe("🔴 Rig 02 has been silent for 2 min with Matt G signed in");
    expect(message.allowed_mentions).toEqual({ parse: [] });
  });

  it("keeps a warning quiet: yellow, and no mention even with an owner id", () => {
    const message = alertMessage({ ...URGENT, severity: "warning" }, OWNER);
    expect(message.content).toBe("🟡 Rig 02 has been silent for 2 min with Matt G signed in");
    expect(message.allowed_mentions).toEqual({ parse: [] });
    expect(message.embeds![0]!.color).toBe(0xf1c40f);
  });

  it("allows no mention a driver's name could carry", () => {
    const message = alertMessage(
      { ...URGENT, severity: "warning", detail: { ...URGENT.detail, headline: "@everyone <@1> hi" } },
      OWNER,
    );
    expect(message.allowed_mentions).toEqual({ parse: [] });
  });

  it("clips to Discord's limits instead of having the whole post refused", () => {
    const long = "x".repeat(5000);
    const message = alertMessage(
      { ...URGENT, detail: { headline: long, where: "Rig 02", fields: [{ name: "Notes", value: long }] } },
      OWNER,
    );
    expect(message.content!.length).toBe(2000);
    expect(message.content!.endsWith("...")).toBe(true);
    expect(message.embeds![0]!.fields![1]!.value.length).toBe(1024);
  });
});

describe("recoveryMessage", () => {
  it("is one quiet line saying what recovered and how long it was open", () => {
    const message = recoveryMessage({ ...URGENT, resolvedAt: OPENED + 6 * 60_000 });
    expect(message).toEqual({
      content: "🟢 Recovered: Rig silent - Rig 02 (alert #123, after 6 min)",
      allowed_mentions: { parse: [] },
    });
  });
});

describe("event mode and the monitor's notes", () => {
  const board = {
    id: "b",
    mode: "event" as const,
    host: "cadillac",
    // 2:31 PM venue time.
    firstSeenAt: Date.parse("2026-10-04T19:31:00Z"),
    lastSeenAt: OPENED,
    visible: true,
    feedOk: true,
    feedFailures: 0,
    closedAt: null,
  };

  it("says in one line why event mode turned on or off", () => {
    expect(eventModeLine({ on: true, cause: "board", board })).toBe(
      "⚪ Event mode on: Event board (Cadillac) opened at 2:31 PM",
    );
    expect(eventModeLine({ on: true, cause: "override", setBy: "Cody", expiresAt: OPENED })).toBe(
      "⚪ Event mode on: started by Cody until midnight",
    );
    expect(eventModeLine({ on: false, cause: "override", setBy: null, expiresAt: OPENED })).toBe(
      "⚪ Event mode off: stopped by staff until midnight",
    );
    expect(eventModeLine({ on: false, cause: "none" })).toBe("⚪ Event mode off: no event board is open");
  });

  it("posts a note as plain content that can mention nobody", () => {
    expect(noteMessage("⚪ Event mode off: no event board is open")).toEqual({
      content: "⚪ Event mode off: no event board is open",
      allowed_mentions: { parse: [] },
    });
  });

  it("names a monitor gap in venue time, with the day when it spans one", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(monitorGapLine({ from: at("2026-10-04T20:02:00Z"), to: at("2026-10-04T20:40:00Z") })).toBe(
      "🟡 Monitor gap: no checks ran from 3:02 PM to 3:40 PM - is the outside clock (cron-job.org) still running?",
    );
    expect(monitorGapLine({ from: at("2026-10-03T20:02:00Z"), to: at("2026-10-04T20:40:00Z") })).toContain(
      "from Oct 3 3:02 PM to 3:40 PM",
    );
  });
});

describe("routineUpdateMessage", () => {
  // 3:40 PM venue time.
  const NOW = Date.parse("2026-10-04T20:40:00Z");
  const MIN = 60_000;
  const beat = (ago: number, overrides: Partial<Heartbeat> = {}): Heartbeat => ({
    id: String(ago),
    receivedAt: NOW - ago,
    sentAt: NOW - ago,
    clockSkewMs: 0,
    processStartedAt: NOW - 3 * 60 * MIN,
    sequence: null,
    agentVersion: "rig-agent/0.4-monitor",
    telemetryMode: "iracing",
    simConnected: true,
    telemetryFaulted: false,
    session: null,
    pendingLaps: 0,
    oldestPendingAgeS: null,
    rejectedLaps: 0,
    checkout: "none",
    missingVariables: [],
    agentCpuPercent: 0.2,
    agentMemoryMb: 40,
    shuttingDown: false,
    ...overrides,
  });
  const SESSION = { trackName: "Circuit of the Americas", trackConfig: "Grand Prix", carName: "FIA F4" };
  const rig = (number: number, overrides: Partial<RigSnapshot>): RigSnapshot => ({
    id: `rig-${number}`,
    number,
    name: `Rig ${String(number).padStart(2, "0")}`,
    lastSeenAt: NOW - 20_000,
    seated: null,
    heartbeats: [beat(20_000)],
    heard: [],
    ...overrides,
  });

  const snapshot: MonitorSnapshot = {
    now: NOW,
    venueDayStart: Date.parse("2026-10-04T05:00:00Z"),
    featuredCombo: SESSION,
    override: null,
    boards: [
      {
        id: "b",
        mode: "event",
        host: "cadillac",
        firstSeenAt: NOW - 70 * MIN,
        lastSeenAt: NOW - 10_000,
        visible: true,
        feedOk: true,
        feedFailures: 0,
        closedAt: null,
      },
    ],
    rigs: [
      rig(1, {
        seated: { driverName: "Matt G", driverStatus: "active", startedAt: NOW - 18 * MIN },
        heartbeats: [beat(20_000, { session: SESSION })],
      }),
      rig(2, {}),
      rig(3, { lastSeenAt: NOW - 48 * 60 * MIN, heartbeats: [] }),
      rig(4, {
        lastSeenAt: NOW - 6 * MIN,
        seated: { driverName: "Bad Name", driverStatus: "name_flagged", startedAt: NOW - 40 * MIN },
        heartbeats: [beat(6 * MIN, { simConnected: false, pendingLaps: 2, rejectedLaps: 1 })],
      }),
      rig(5, { lastSeenAt: NOW - 2 * 60 * MIN, heartbeats: [beat(2 * 60 * MIN, { shuttingDown: true })] }),
    ],
    openAlerts: [],
  };

  const facts: RoutineFacts = {
    driversToday: 24,
    top: [
      { displayName: "Ana Bell", lapTimeMs: 137_217 },
      { displayName: "carl dunn", lapTimeMs: 138_004 },
      { displayName: "Eve", lapTimeMs: 139_940 },
    ],
    lapsLast20Min: 6,
    lastLapAtByRig: new Map([
      ["rig-1", Date.parse("2026-10-04T20:37:00Z")],
      ["rig-2", Date.parse("2026-10-04T20:12:00Z")],
    ]),
    activeAlerts: [],
  };

  it("is the fixed template: board, one line per rig on today, the top three, and the alerts", () => {
    const message = routineUpdateMessage(snapshot, facts, NOW + 20 * MIN);
    expect(message.content).toBe("🟢 Oasis event update · 3:40 PM  (next about 4:00 PM)");
    expect(message.allowed_mentions).toEqual({ parse: [] });
    expect(message.embeds![0]!.color).toBe(0x2ecc71);
    expect(message.embeds![0]!.description!.split("\n")).toEqual([
      "Board: live · Circuit of the Americas Grand Prix · FIA F4 · 24 drivers today · 6 laps in the last 20 min",
      "Rig 01  online · iRacing in session · Matt G (seated 18 min) · last lap 3:37 PM · queue 0 · agent 0.4-monitor",
      "Rig 02  online · iRacing idle · nobody signed in · last lap 3:12 PM · queue 0 · agent 0.4-monitor",
      "Rig 04  silent 6 min · iRacing not running · a driver (name under review) (seated 40 min) · no laps today · queue 2, 1 parked · agent 0.4-monitor",
      "Rig 05  agent closed · nobody signed in · no laps today · queue 0 · agent 0.4-monitor",
      "1 other rig not on today",
      "Top 3 today: 1. 2:17.217 A.B.  2. 2:18.004 C.D.  3. 2:19.940 E.",
      "Active alerts: none",
    ]);
  });

  it("turns red with the worst open alert and lists them, and says when the board went dark", () => {
    const dark = { ...snapshot, boards: [{ ...snapshot.boards[0]!, lastSeenAt: NOW - 5 * MIN }] };
    const message = routineUpdateMessage(
      dark,
      {
        ...facts,
        top: [],
        activeAlerts: [
          { severity: "warning", headline: "Rig 02: a sign-out could not be saved" },
          { severity: "urgent", headline: "Event board (Cadillac) has not been heard from for 5 min" },
        ],
      },
      NOW + 20 * MIN,
    );
    expect(message.content).toBe("🔴 Oasis event update · 3:40 PM  (next about 4:00 PM)");
    expect(message.embeds![0]!.color).toBe(0xe74c3c);
    const lines = message.embeds![0]!.description!.split("\n");
    expect(lines[0]).toMatch(/^Board: dark 5 min · /);
    expect(lines.slice(-3)).toEqual([
      "Top 3 today: no valid laps yet",
      "Active alerts: 🟡 Rig 02: a sign-out could not be saved",
      "🔴 Event board (Cadillac) has not been heard from for 5 min",
    ]);
  });
});
