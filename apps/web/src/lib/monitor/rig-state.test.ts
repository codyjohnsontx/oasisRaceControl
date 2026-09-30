import { describe, expect, it } from "vitest";
import { holdingSince, inSendOrder, lastSent, rigState, sentBefore, type Heartbeat } from "./rig-state";

const T = Date.parse("2026-10-04T21:00:00Z");
const STARTED = T - 3_600_000;

function hb(id: string, receivedAt: number, overrides: Partial<Heartbeat> = {}): Heartbeat {
  return {
    id,
    receivedAt,
    sentAt: receivedAt,
    clockSkewMs: 0,
    processStartedAt: STARTED,
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
    signInFailures: 0,
    signInFailureKinds: [],
    missingVariables: [],
    agentCpuPercent: 0.2,
    agentMemoryMb: 40,
    shuttingDown: false,
    ...overrides,
  };
}

/** A v1 heartbeat: nothing but that it arrived. */
function v1(id: string, receivedAt: number): Heartbeat {
  return hb(id, receivedAt, { sentAt: null, processStartedAt: null, sequence: null });
}

describe("sentBefore", () => {
  it("orders one process's heartbeats by sequence, not by the rig's clock", () => {
    // The rig's clock was corrected backwards between the two sends.
    const earlier = hb("a", T, { sequence: 41, sentAt: T });
    const later = hb("b", T + 1000, { sequence: 42, sentAt: T - 30_000 });
    expect(sentBefore(earlier, later)).toBe(true);
    expect(sentBefore(later, earlier)).toBe(false);
  });

  it("proves nothing between different processes, whose starts are on the rig's clock", () => {
    const old = hb("a", T, { sequence: 500 });
    const restarted = hb("b", T, { sequence: 1, processStartedAt: STARTED + 60_000 });
    expect(sentBefore(old, restarted)).toBe(false);
    expect(sentBefore(restarted, old)).toBe(false);
  });

  it("falls back to sentAt when there is no sequence", () => {
    expect(sentBefore(hb("a", T + 5000, { sentAt: T }), hb("b", T, { sentAt: T + 1 }))).toBe(true);
  });

  it("proves nothing between heartbeats that carry no order", () => {
    expect(sentBefore(v1("a", T), v1("b", T + 1000))).toBe(false);
    expect(sentBefore(v1("b", T + 1000), v1("a", T))).toBe(false);
  });
});

describe("inSendOrder and lastSent", () => {
  it("move a late heartbeat back to where it was sent, and leave the rest in arrival order", () => {
    const rows = [
      hb("2", T, { sequence: 2, simConnected: true }),
      hb("3", T + 60_000, { sequence: 3, shuttingDown: true }),
      hb("1", T + 61_000, { sequence: 1, simConnected: true }),
      v1("v1", T + 62_000),
    ];
    expect(inSendOrder(rows).map((h) => h.id)).toEqual(["1", "2", "3", "v1"]);
    expect(lastSent(rows.slice(0, 3), (h) => !h.shuttingDown)?.id).toBe("2");
  });
});

describe("rigState", () => {
  it("is the latest heartbeat to arrive when they arrive in order", () => {
    const rows = [hb("a", T, { sequence: 1 }), hb("b", T + 60_000, { sequence: 2 })];
    expect(rigState(rows)?.id).toBe("b");
  });

  it("keeps a goodbye standing when an ordinary heartbeat sent before it lands after it", () => {
    // The carry-in from PR 40's review: heartbeat 42 was on the wire when the
    // agent said goodbye as 43, and arrived second.
    const rows = [
      hb("41", T, { sequence: 41 }),
      hb("43", T + 60_000, { sequence: 43, shuttingDown: true }),
      hb("42", T + 60_400, { sequence: 42 }),
    ];
    expect(rigState(rows)?.id).toBe("43");
    expect(rigState(rows)?.shuttingDown).toBe(true);
  });

  it("keeps a goodbye standing against an earlier sentAt when there is no sequence", () => {
    const rows = [
      hb("bye", T, { sentAt: T, shuttingDown: true }),
      hb("late", T + 2000, { sentAt: T - 5000 }),
    ];
    expect(rigState(rows)?.shuttingDown).toBe(true);
  });

  it("lets a new process's first heartbeat replace the previous process's goodbye", () => {
    const rows = [
      hb("bye", T, { sequence: 900, shuttingDown: true }),
      hb("back", T + 120_000, { sequence: 1, processStartedAt: T + 110_000 }),
    ];
    expect(rigState(rows)?.id).toBe("back");
  });

  it("orders processes on the server's clock when the rig's clock moved between them", () => {
    // The rig came back up with its clock a year slow.
    const year = 365 * 24 * 3_600_000;
    const rows = [
      hb("bye", T, { sequence: 900, shuttingDown: true }),
      hb("back", T + 120_000, {
        sequence: 1,
        processStartedAt: T + 110_000 - year,
        sentAt: T + 120_000 - year,
        clockSkewMs: year,
      }),
    ];
    expect(rigState(rows)?.id).toBe("back");
  });

  it("lets a new process replace a goodbye sent after the rig's clock was set back", () => {
    // The old agent started on a clock two hours fast, corrected while it ran.
    const rows = [
      hb("bye", T, { sequence: 900, processStartedAt: T + 7_200_000 - 3_600_000, shuttingDown: true }),
      hb("back", T + 120_000, { sequence: 1, processStartedAt: T + 110_000 }),
    ];
    expect(rigState(rows)?.id).toBe("back");
  });

  it("takes v1 heartbeats in arrival order, as before", () => {
    expect(rigState([v1("a", T), v1("b", T + 30_000)])?.id).toBe("b");
  });

  it("is null for a rig with no heartbeats", () => {
    expect(rigState([])).toBeNull();
  });
});

describe("holdingSince", () => {
  const rows = [
    hb("1", T, { simConnected: true }),
    hb("2", T + 60_000, { simConnected: false }),
    hb("3", T + 120_000, { simConnected: false }),
    hb("4", T + 180_000, { simConnected: false }),
  ];
  const disconnected = (h: Heartbeat) => h.simConnected === false;

  it("is the arrival of the first heartbeat in the unbroken run", () => {
    expect(holdingSince(rows, rows[3]!, disconnected)).toBe(T + 60_000);
  });

  it("is null when the standing heartbeat does not hold", () => {
    expect(holdingSince(rows, rows[0]!, disconnected)).toBeNull();
  });

  it("is broken by a heartbeat that cannot say, and by a goodbye", () => {
    const unknown = [rows[1]!, hb("x", T + 90_000, { simConnected: null }), rows[2]!];
    expect(holdingSince(unknown, rows[2]!, disconnected)).toBe(T + 120_000);
    const bye = [rows[1]!, hb("y", T + 90_000, { simConnected: false, shuttingDown: true }), rows[2]!];
    expect(holdingSince(bye, rows[2]!, disconnected)).toBe(T + 120_000);
  });
});
