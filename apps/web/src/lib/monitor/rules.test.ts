import { describe, expect, it } from "vitest";
import type { Heartbeat } from "./rig-state";
import {
  evaluateRules,
  rigSubject,
  VENUE_SUBJECT,
  type Finding,
  type MonitorSnapshot,
  type RigSnapshot,
  type RuleKey,
} from "./rules";

/**
 * One snapshot per rule for each of its three states: it fires, it holds
 * while the problem persists (including the ways a rule is deliberately held
 * open), and it clears. "Clears" here means the finding is gone; turning two
 * absent evaluations into one recovery message is the alert state's job
 * (store.ts), tested against Postgres.
 */

const NOW = Date.parse("2026-10-04T21:00:00Z");
const S = 1000;
const MIN = 60 * S;
const STARTED = NOW - 3 * 60 * MIN;

let nextId = 0;

function hb(ago: number, overrides: Partial<Heartbeat> = {}): Heartbeat {
  const receivedAt = NOW - ago;
  return {
    id: String(++nextId),
    receivedAt,
    sentAt: receivedAt,
    clockSkewMs: 0,
    processStartedAt: STARTED,
    sequence: Math.round((receivedAt - STARTED) / MIN),
    agentVersion: "rig-agent/0.4-monitor",
    telemetryMode: "iracing",
    simConnected: true,
    telemetryFaulted: false,
    pendingLaps: 0,
    oldestPendingAgeS: null,
    rejectedLaps: 0,
    checkout: "none",
    missingVariables: [],
    agentCpuPercent: 0.2,
    agentMemoryMb: 40,
    shuttingDown: false,
    ...overrides,
  };
}

/** A heartbeat every minute from `from` ago up to `to` ago, each shaped by `shape`. */
function minutely(
  from: number,
  to = 0,
  shape: (ago: number) => Partial<Heartbeat> = () => ({}),
): Heartbeat[] {
  const rows: Heartbeat[] = [];
  for (let ago = from; ago >= to; ago -= MIN) rows.push(hb(ago, shape(ago)));
  return rows;
}

function rig(number: number, overrides: Partial<RigSnapshot> = {}): RigSnapshot {
  const heartbeats = overrides.heartbeats ?? minutely(14 * MIN);
  return {
    id: `rig-${number}`,
    number,
    name: `Rig ${String(number).padStart(2, "0")}`,
    lastSeenAt: heartbeats.at(-1)?.receivedAt ?? null,
    seated: null,
    heartbeats,
    ...overrides,
  };
}

const SEATED = { driverName: "Matt G", startedAt: NOW - 30 * MIN };

function evaluate(
  rigs: RigSnapshot[],
  openAlerts: Array<{ rule: RuleKey; subject: string }> = [],
): Finding[] {
  const snapshot: MonitorSnapshot = { now: NOW, rigs, openAlerts };
  return evaluateRules(snapshot);
}

function rulesOf(findings: Finding[]): string[] {
  return findings.map((f) => `${f.rule} ${f.subject} ${f.severity}`).sort();
}

function only(findings: Finding[], rule: RuleKey): Finding | undefined {
  return findings.find((f) => f.rule === rule);
}

describe("a healthy venue", () => {
  it("has no findings", () => {
    expect(evaluate([rig(1, { seated: SEATED }), rig(2)])).toEqual([]);
  });

  it("has none for a rig that has never reported", () => {
    expect(evaluate([rig(1, { heartbeats: [], lastSeenAt: null })])).toEqual([]);
  });
});

describe("rule 1: rig silent", () => {
  /** Heartbeats up to `quietFor` ago, and nothing since. */
  const quiet = (number: number, quietFor: number, overrides: Partial<RigSnapshot> = {}) =>
    rig(number, { heartbeats: minutely(quietFor + 14 * MIN, quietFor), ...overrides });

  it("fires urgent once a seated rig has been silent past two minutes", () => {
    const findings = evaluate([quiet(1, 2 * MIN + 5 * S, { seated: SEATED }), rig(2)]);
    expect(rulesOf(findings)).toEqual(["rig_silent rig:rig-1 urgent"]);
    expect(only(findings, "rig_silent")!.detail.headline).toBe(
      "Rig 01 has been silent for 2 min with Matt G signed in",
    );
  });

  it("does not fire on one failed heartbeat and its retry", () => {
    // 60 s cadence, the send times out after 15 s, the retry goes 10 s later:
    // about 90 s between arrivals, which must stay quiet.
    expect(evaluate([quiet(1, 90 * S, { seated: SEATED })])).toEqual([]);
  });

  it("never fires for a rig that said goodbye", () => {
    const heartbeats = [...minutely(20 * MIN, 11 * MIN), hb(10 * MIN, { shuttingDown: true })];
    expect(evaluate([rig(1, { heartbeats, seated: SEATED })])).toEqual([]);
  });

  it("never fires when an ordinary heartbeat sent before the goodbye lands after it", () => {
    const bye = hb(10 * MIN, { shuttingDown: true });
    const overtaken = hb(10 * MIN - 400, { sequence: bye.sequence! - 1, sentAt: bye.sentAt! - 1000 });
    const heartbeats = [...minutely(20 * MIN, 11 * MIN), bye, overtaken];
    expect(evaluate([rig(1, { heartbeats, seated: SEATED })])).toEqual([]);
  });

  it("fires again for a rig whose new process went silent after an earlier goodbye", () => {
    const heartbeats = [
      hb(30 * MIN, { shuttingDown: true }),
      hb(8 * MIN, { processStartedAt: NOW - 9 * MIN, sequence: 1 }),
    ];
    expect(rulesOf(evaluate([rig(1, { heartbeats, seated: SEATED })]))).toEqual([
      "rig_silent rig:rig-1 urgent",
    ]);
  });

  it("waits out the correlation window before warning about an empty rig", () => {
    expect(evaluate([quiet(1, 4 * MIN), rig(2)])).toEqual([]);
    expect(rulesOf(evaluate([quiet(1, 7 * MIN), rig(2)]))).toEqual([
      "rig_silent rig:rig-1 warning",
    ]);
  });

  it("reads empty rigs going quiet together, with none left running, as one venue note", () => {
    const findings = evaluate([quiet(1, 3 * MIN), quiet(2, 6 * MIN), quiet(3, 9 * MIN, { heartbeats: [] })]);
    expect(rulesOf(findings)).toEqual([`venue_silent ${VENUE_SUBJECT} warning`]);
    expect(findings[0]!.detail.headline).toBe("Rig 01, Rig 02 went quiet together - venue closed?");
  });

  it("does not call it the venue closing while another rig is still running", () => {
    expect(evaluate([quiet(1, 3 * MIN), quiet(2, 4 * MIN), rig(3)])).toEqual([]);
  });

  it("does not call it the venue closing when the rigs went quiet far apart", () => {
    expect(rulesOf(evaluate([quiet(1, 8 * MIN), quiet(2, 20 * MIN)]))).toEqual([
      "rig_silent rig:rig-1 warning",
      "rig_silent rig:rig-2 warning",
    ]);
  });

  it("keeps a seated rig's own urgent alert when the venue goes quiet around it", () => {
    const findings = evaluate([
      quiet(1, 3 * MIN, { seated: SEATED }),
      quiet(2, 3 * MIN),
      quiet(3, 4 * MIN),
    ]);
    expect(rulesOf(findings)).toEqual([
      "rig_silent rig:rig-1 urgent",
      `venue_silent ${VENUE_SUBJECT} warning`,
    ]);
  });

  it("holds the venue note until a rig is heard again", () => {
    const open = [{ rule: "venue_silent" as const, subject: VENUE_SUBJECT }];
    // Long past the twelve-hour lookback, nothing is newly silent.
    const overnight = [quiet(1, 13 * 60 * MIN), quiet(2, 13 * 60 * MIN)];
    expect(rulesOf(evaluate(overnight, open))).toEqual([`venue_silent ${VENUE_SUBJECT} warning`]);
    expect(evaluate([quiet(1, 13 * 60 * MIN), rig(2)], open)).toEqual([]);
  });

  it("does not open for a rig quiet past the lookback, but holds one already open", () => {
    const longGone = quiet(1, 13 * 60 * MIN, { seated: SEATED });
    expect(evaluate([longGone, rig(2)])).toEqual([]);
    expect(
      rulesOf(evaluate([longGone, rig(2)], [{ rule: "rig_silent", subject: rigSubject("rig-1") }])),
    ).toEqual(["rig_silent rig:rig-1 urgent"]);
  });

  it("clears when the rig is heard again", () => {
    expect(evaluate([rig(1, { seated: SEATED })], [{ rule: "rig_silent", subject: rigSubject("rig-1") }])).toEqual([]);
  });
});

describe("rule 2: iRacing not connected while a driver is signed in", () => {
  const disconnectedFor = (duration: number) =>
    minutely(14 * MIN, 0, (ago) => ({ simConnected: ago > duration }));

  it("fires once iRacing has been gone three minutes with a driver seated", () => {
    const findings = evaluate([rig(1, { seated: SEATED, heartbeats: disconnectedFor(4 * MIN) })]);
    expect(rulesOf(findings)).toEqual(["sim_disconnected rig:rig-1 urgent"]);
    expect(findings[0]!.detail.headline).toBe(
      "Rig 01: iRacing not connected for 4 min while Matt G is signed in",
    );
  });

  it("gives a session load its minute", () => {
    expect(evaluate([rig(1, { seated: SEATED, heartbeats: disconnectedFor(2 * MIN) })])).toEqual([]);
  });

  it("counts from when the driver sat down, not from when iRacing closed", () => {
    const justSeated = { driverName: "Matt G", startedAt: NOW - 2 * MIN };
    expect(evaluate([rig(1, { seated: justSeated, heartbeats: disconnectedFor(10 * MIN) })])).toEqual([]);
  });

  it("does not fire with nobody seated, or on a rig not reading iRacing", () => {
    expect(evaluate([rig(1, { heartbeats: disconnectedFor(10 * MIN) })])).toEqual([]);
    const none = minutely(14 * MIN, 0, () => ({ telemetryMode: "none", simConnected: false }));
    expect(evaluate([rig(1, { seated: SEATED, heartbeats: none })])).toEqual([]);
  });

  it("clears when iRacing connects", () => {
    const back = minutely(14 * MIN, 0, (ago) => ({ simConnected: ago > 10 * MIN || ago === 0 }));
    expect(evaluate([rig(1, { seated: SEATED, heartbeats: back })])).toEqual([]);
  });
});

describe("rule 3a: laps queued but not reaching the site", () => {
  /** Laps queued `age` ago, still pending on every heartbeat since. */
  const stuck = (age: number) =>
    minutely(14 * MIN, 0, (ago) =>
      ago < age ? { pendingLaps: 2, oldestPendingAgeS: (age - ago) / S } : {},
    );

  it("fires when a lap has waited past two minutes while heartbeats kept arriving", () => {
    const findings = evaluate([rig(1, { heartbeats: stuck(5 * MIN) })]);
    expect(rulesOf(findings)).toEqual(["laps_stuck rig:rig-1 urgent"]);
    expect(findings[0]!.detail.headline).toBe(
      "Rig 01: 2 laps waiting 5 min to reach the site while the rig is online",
    );
  });

  it("does not fire on the first heartbeat after an outage, before the backlog can drain", () => {
    // Offline for ten minutes; the one heartbeat since shows laps from then.
    const heartbeats = [
      ...minutely(20 * MIN, 11 * MIN),
      hb(0, { pendingLaps: 4, oldestPendingAgeS: 10 * 60 }),
    ];
    expect(evaluate([rig(1, { heartbeats })])).toEqual([]);
  });

  it("does not fire before two minutes", () => {
    expect(evaluate([rig(1, { heartbeats: stuck(110 * S) })])).toEqual([]);
  });

  it("clears when the queue drains", () => {
    const drained = [...stuck(5 * MIN).slice(0, -1), hb(0)];
    expect(evaluate([rig(1, { heartbeats: drained })])).toEqual([]);
  });
});

describe("rule 3b: laps refused by the site", () => {
  const refused = (n: number, extra: Partial<Heartbeat> = {}) =>
    [...minutely(14 * MIN, MIN), hb(0, { rejectedLaps: n, ...extra })];

  it("fires on any parked lap, with the count as its level", () => {
    const findings = evaluate([rig(1, { heartbeats: refused(3) })]);
    expect(rulesOf(findings)).toEqual(["laps_refused rig:rig-1 urgent"]);
    expect(findings[0]!.level).toBe(3);
    expect(findings[0]!.detail.headline).toBe(
      "Rig 01: the site refused 3 laps; they are parked on the rig",
    );
  });

  it("holds through a goodbye: closing the agent does not deliver them", () => {
    expect(rulesOf(evaluate([rig(1, { heartbeats: refused(1, { shuttingDown: true }) })]))).toEqual([
      "laps_refused rig:rig-1 urgent",
    ]);
  });

  it("clears only when the count is back to zero - a person un-parked them", () => {
    expect(evaluate([rig(1, { heartbeats: refused(0) })])).toEqual([]);
  });
});

describe("rule 10: rig agent restarting repeatedly", () => {
  /** One heartbeat from each of these process starts (minutes ago). */
  const starts = (...minutesAgo: number[]) =>
    minutesAgo.map((m) => hb(m * MIN - 20 * S, { processStartedAt: NOW - m * MIN, sequence: 1 }));

  it("fires on three starts inside fifteen minutes", () => {
    const findings = evaluate([rig(1, { heartbeats: starts(12, 7, 2) })]);
    expect(rulesOf(findings)).toEqual(["agent_restarting rig:rig-1 urgent"]);
    expect(findings[0]!.detail.headline).toBe("Rig 01: the rig agent started 3 times in 15 min");
  });

  it("places each start on the server's clock with that heartbeat's skew", () => {
    // The rig's clock runs ten minutes slow, so its "20 minutes ago" is ten.
    const skewed = starts(20, 18, 16).map((h) => ({ ...h, clockSkewMs: 10 * MIN }));
    expect(rulesOf(evaluate([rig(1, { heartbeats: skewed })]))).toContain(
      "agent_restarting rig:rig-1 urgent",
    );
  });

  it("does not fire on two", () => {
    expect(evaluate([rig(1, { heartbeats: starts(7, 2) })])).toEqual([]);
  });

  it("clears once the starts age out of the window", () => {
    expect(evaluate([rig(1, { heartbeats: [...starts(40, 30, 20), ...minutely(14 * MIN, 0, () => ({ processStartedAt: NOW - 20 * MIN }))] })])).toEqual([]);
  });
});

describe("rule 12: rig clock off", () => {
  const skewed = (ms: number) => [...minutely(14 * MIN, MIN), hb(0, { clockSkewMs: ms })];
  const open = [{ rule: "clock_skew" as const, subject: rigSubject("rig-1") }];

  it("fires past five minutes either way, saying which way", () => {
    const behind = evaluate([rig(1, { heartbeats: skewed(6 * MIN) })]);
    expect(rulesOf(behind)).toEqual(["clock_skew rig:rig-1 urgent"]);
    expect(behind[0]!.detail.headline).toMatch(/^Rig 01: its clock is 6 min behind the server's/);
    const ahead = evaluate([rig(1, { heartbeats: skewed(-6 * MIN) })]);
    expect(ahead[0]!.detail.headline).toMatch(/6 min ahead of the server's/);
  });

  it("does not open between two and five minutes, but holds an open one there", () => {
    expect(evaluate([rig(1, { heartbeats: skewed(3 * MIN) })])).toEqual([]);
    expect(rulesOf(evaluate([rig(1, { heartbeats: skewed(3 * MIN) })], open))).toEqual([
      "clock_skew rig:rig-1 urgent",
    ]);
  });

  it("clears under two minutes", () => {
    expect(evaluate([rig(1, { heartbeats: skewed(90 * S) })], open)).toEqual([]);
  });
});

describe("rules 15, 16 and 17: what the agent reports about itself", () => {
  const latest = (extra: Partial<Heartbeat>) => [...minutely(14 * MIN, MIN), hb(0, extra)];

  it("15 fires urgent when lap reading stopped, and clears after a restart", () => {
    expect(rulesOf(evaluate([rig(1, { heartbeats: latest({ telemetryFaulted: true }) })]))).toEqual([
      "telemetry_faulted rig:rig-1 urgent",
    ]);
    expect(evaluate([rig(1, { heartbeats: latest({ telemetryFaulted: false }) })])).toEqual([]);
  });

  it("16 warns when a sign-out could not be saved, and clears once it is", () => {
    expect(rulesOf(evaluate([rig(1, { heartbeats: latest({ checkout: "not_queued" }) })]))).toEqual([
      "checkout_not_saved rig:rig-1 warning",
    ]);
    expect(evaluate([rig(1, { heartbeats: latest({ checkout: "queued" }) })])).toEqual([]);
  });

  it("17 warns about variables iRacing does not publish, naming them", () => {
    const findings = evaluate([rig(1, { heartbeats: latest({ missingVariables: ["LapLastLapTime", "PlayerCarIdx"] }) })]);
    expect(rulesOf(findings)).toEqual(["missing_variables rig:rig-1 warning"]);
    expect(findings[0]!.detail.headline).toBe(
      "Rig 01: this iRacing build does not publish LapLastLapTime, PlayerCarIdx",
    );
    expect(evaluate([rig(1, { heartbeats: latest({ missingVariables: [] }) })])).toEqual([]);
  });

  it("stay quiet once the agent has said goodbye", () => {
    const bye = latest({ telemetryFaulted: true, checkout: "not_queued", missingVariables: ["X"], shuttingDown: true });
    expect(evaluate([rig(1, { heartbeats: bye })])).toEqual([]);
  });
});

describe("rule 18: rig agent footprint", () => {
  it("warns at once on memory over 150 MB", () => {
    const heartbeats = [...minutely(14 * MIN, MIN), hb(0, { agentMemoryMb: 180, agentCpuPercent: null })];
    const findings = evaluate([rig(1, { heartbeats })]);
    expect(rulesOf(findings)).toEqual(["footprint_high rig:rig-1 warning"]);
    expect(findings[0]!.detail.headline).toBe(
      "Rig 01: the rig agent is using 180 MB - iRacing should not have to share that",
    );
  });

  it("warns on CPU over 2% of a core only once it has lasted five minutes", () => {
    const busyFor = (d: number) => minutely(14 * MIN, 0, (ago) => ({ agentCpuPercent: ago <= d ? 4 : 0.2 }));
    expect(rulesOf(evaluate([rig(1, { heartbeats: busyFor(6 * MIN) })]))).toEqual([
      "footprint_high rig:rig-1 warning",
    ]);
    expect(evaluate([rig(1, { heartbeats: busyFor(3 * MIN) })])).toEqual([]);
  });

  it("clears when the latest heartbeat is back under both", () => {
    const heartbeats = minutely(14 * MIN, 0, (ago) => ({ agentCpuPercent: ago > 0 ? 4 : 0.3 }));
    expect(evaluate([rig(1, { heartbeats })])).toEqual([]);
  });
});
