import { describe, expect, it } from "vitest";
import type { Heartbeat } from "./rig-state";
import { CURRENT_AGENT_VERSION } from "./agent-version";
import {
  evaluateRules,
  inEventMode,
  outdatedAgentSubject,
  RECOVERS_SILENTLY,
  rigSubject,
  VENUE_SUBJECT,
  type FeaturedCombo,
  type Finding,
  type LapSnapshot,
  type MonitorSnapshot,
  type RigSnapshot,
  type RuleKey,
  SILENT_AFTER_MS,
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
    agentVersion: CURRENT_AGENT_VERSION,
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
    signInFailureSeqs: null,
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

/** The heartbeats' unbroken runs, as the snapshot's `heard` holds them. */
function runsOf(heartbeats: Heartbeat[]): RigSnapshot["heard"] {
  const runs: RigSnapshot["heard"] = [];
  for (const { receivedAt } of heartbeats) {
    const last = runs.at(-1);
    if (last && receivedAt - last.to <= SILENT_AFTER_MS) last.to = receivedAt;
    else runs.push({ from: receivedAt, to: receivedAt });
  }
  return runs;
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
    heard: runsOf(heartbeats),
    ...overrides,
  };
}

const SEATED = { driverName: "Matt G", driverStatus: "active", startedAt: NOW - 30 * MIN };

/** A snapshot with nothing but rigs: no combo, no laps, no moves. */
function snapshotOf(
  rigs: RigSnapshot[],
  openAlerts: Array<{ rule: RuleKey; subject: string }> = [],
  rest: Partial<MonitorSnapshot> = {},
): MonitorSnapshot {
  return {
    now: NOW,
    rigs,
    featuredCombo: null,
    longStintMinutes: 120,
    laps: [],
    lapBests: [],
    moves: [],
    openAlerts,
    ...rest,
  };
}

function evaluate(
  rigs: RigSnapshot[],
  openAlerts: Array<{ rule: RuleKey; subject: string }> = [],
  rest: Partial<MonitorSnapshot> = {},
): Finding[] {
  return evaluateRules(snapshotOf(rigs, openAlerts, rest));
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

  it("holds the note, not a warning, for the last rig of a close still inside the lookback", () => {
    const open = [{ rule: "venue_silent" as const, subject: VENUE_SUBJECT }];
    const aging = [quiet(1, 12 * 60 * MIN + 20 * S), quiet(2, 12 * 60 * MIN - 20 * S)];
    expect(rulesOf(evaluate(aging, open))).toEqual([`venue_silent ${VENUE_SUBJECT} warning`]);
  });

  describe("when the venue comes back", () => {
    const open = [{ rule: "venue_silent" as const, subject: VENUE_SUBJECT }];
    /** Heard up to `lostAt` ago, then nothing until `backAt` ago, and every minute since. */
    const back = (number: number, lostAt: number, backAt: number) =>
      rig(number, { heartbeats: [...minutely(lostAt + 10 * MIN, lostAt), ...minutely(backAt)] });

    it("holds the venue note, not a warning per rig, while the rest are still coming back", () => {
      const findings = evaluate([back(1, 12 * MIN, 2 * MIN), quiet(2, 12 * MIN), quiet(3, 12 * MIN)], open);
      expect(rulesOf(findings)).toEqual([`venue_silent ${VENUE_SUBJECT} warning`]);
    });

    it("waits out the slowest backed-off heartbeat: the last of twenty back 330 s after the first", () => {
      const rigs = [
        back(1, 15 * MIN, 330 * S),
        ...Array.from({ length: 18 }, (_, i) => back(i + 2, 15 * MIN, (300 - i * 15) * S)),
        quiet(20, 15 * MIN),
      ];
      expect(rulesOf(evaluate(rigs, open))).toEqual([`venue_silent ${VENUE_SUBJECT} warning`]);
    });

    it("counts a rig back when its laps land before its next heartbeat", () => {
      const flushed = rig(1, { heartbeats: minutely(22 * MIN, 12 * MIN), lastSeenAt: NOW - 10 * S });
      const findings = evaluate([flushed, quiet(2, 12 * MIN), quiet(3, 12 * MIN)], open);
      expect(rulesOf(findings)).toEqual([`venue_silent ${VENUE_SUBJECT} warning`]);
    });

    it("lets the note clear once the window after the first one back has passed, warning about no rig still dark", () => {
      expect(evaluate([back(1, 12 * MIN, 8 * MIN), quiet(2, 12 * MIN), quiet(3, 12 * MIN)], open)).toEqual([]);
    });

    it("judges a rig that went quiet after the venue came back as before", () => {
      const cameBackThenDied = rig(2, { heartbeats: [...minutely(30 * MIN, 25 * MIN), ...minutely(20 * MIN, 8 * MIN)] });
      const findings = evaluate([back(1, 25 * MIN, 20 * MIN), cameBackThenDied, quiet(3, 25 * MIN)]);
      expect(rulesOf(findings)).toEqual(["rig_silent rig:rig-2 warning"]);
    });

    it("still alerts at once for a seated rig that has not come back", () => {
      const findings = evaluate(
        [back(1, 12 * MIN, 2 * MIN), quiet(2, 12 * MIN, { seated: SEATED }), quiet(3, 12 * MIN)],
        open,
      );
      expect(rulesOf(findings)).toEqual([
        "rig_silent rig:rig-2 urgent",
        `venue_silent ${VENUE_SUBJECT} warning`,
      ]);
    });
  });

  describe("the morning after a close with no goodbyes", () => {
    const open = [{ rule: "venue_silent" as const, subject: VENUE_SUBJECT }];
    const HOUR = 60 * MIN;
    /** Heard until the close `closedAgo` ago, then from `bootedAgo` ago until `until` ago. */
    const closed = (number: number, closedAgo: number, bootedAgo: number, until = 0) =>
      rig(number, {
        heartbeats: [...minutely(closedAgo + 10 * MIN, closedAgo), ...minutely(bootedAgo, until)],
      });
    /**
     * Twenty empty rigs went quiet together at 23:00 and are booted one every
     * four minutes from 10:00, `into` the opening past 10:00.
     */
    const opening = (into: number) => {
      const closedAgo = 11 * HOUR + into;
      return Array.from({ length: 20 }, (_, i) => {
        const bootedAgo = into - i * 4 * MIN;
        return bootedAgo >= 0 ? closed(i + 1, closedAgo, bootedAgo) : quiet(i + 1, closedAgo);
      });
    };
    const perRig = (findings: Finding[]) => findings.filter((f) => f.rule === "rig_silent");

    it("warns about no rig still switched off while they are booted one by one", () => {
      for (let into = 0; into <= 75 * MIN; into += MIN) {
        const findings = evaluate(opening(into), into < 7 * MIN ? open : []);
        expect(perRig(findings), `${into / MIN} min into the opening`).toEqual([]);
      }
    });

    it("resolves the note once rigs are live and the grace has passed", () => {
      expect(rulesOf(evaluate(opening(3 * MIN), open))).toEqual([`venue_silent ${VENUE_SUBJECT} warning`]);
      expect(evaluate(opening(8 * MIN), open)).toEqual([]);
    });

    it("warns about none when the note never opened overnight because evaluations stopped", () => {
      for (const into of [0, 10 * MIN, 45 * MIN]) {
        expect(evaluate(opening(into)), `${into / MIN} min into the opening`).toEqual([]);
      }
    });

    it("warns about none still dark past the twelve-hour lookback", () => {
      const lateOpening = [rig(1), ...Array.from({ length: 19 }, (_, i) => quiet(i + 2, 13 * HOUR))];
      expect(evaluate(lateOpening)).toEqual([]);
    });

    it("keeps a seated rig's urgent alert while it is still dark", () => {
      const findings = evaluate([rig(1), quiet(2, 11 * HOUR, { seated: SEATED }), quiet(3, 11 * HOUR)]);
      expect(rulesOf(findings)).toEqual(["rig_silent rig:rig-2 urgent"]);
    });

    it("alerts normally for a rig that came back and then went quiet", () => {
      const findings = evaluate([
        closed(1, 11 * HOUR, 30 * MIN),
        closed(2, 11 * HOUR, 25 * MIN, 8 * MIN),
        quiet(3, 11 * HOUR),
      ]);
      expect(rulesOf(findings)).toEqual(["rig_silent rig:rig-2 warning"]);
    });

    const stillOff = (closedAgo: number) =>
      Array.from({ length: 18 }, (_, i) => quiet(i + 3, closedAgo));

    it("warns about the first rig booted when it fails before the next is booted", () => {
      const first = closed(1, 11 * HOUR, 10 * MIN, 7 * MIN);
      expect(rulesOf(evaluate([first, ...stillOff(11 * HOUR)], open))).toEqual([
        "rig_silent rig:rig-1 warning",
        `venue_silent ${VENUE_SUBJECT} warning`,
      ]);
    });

    it("still warns about it once the next rig is booted", () => {
      const first = closed(1, 11 * HOUR, 20 * MIN, 17 * MIN);
      const second = closed(2, 11 * HOUR, 10 * MIN);
      expect(rulesOf(evaluate([first, second, ...stillOff(11 * HOUR)]))).toEqual([
        "rig_silent rig:rig-1 warning",
      ]);
    });

    it("warns about the first rig booted after a close more than twelve hours ago when it fails", () => {
      const first = closed(1, 13 * HOUR, 10 * MIN, 7 * MIN);
      expect(rulesOf(evaluate([first, ...stillOff(13 * HOUR)], open))).toEqual([
        "rig_silent rig:rig-1 warning",
        `venue_silent ${VENUE_SUBJECT} warning`,
      ]);
    });
  });

  describe("a lone rig that crashes shortly before another is booted", () => {
    it("is warned about when its warning comes due", () => {
      const findings = evaluate([quiet(3, 7 * MIN), rig(1, { heartbeats: minutely(2 * MIN) })]);
      expect(rulesOf(findings)).toEqual(["rig_silent rig:rig-3 warning"]);
    });

    it("is still warned about later", () => {
      const findings = evaluate([quiet(3, 20 * MIN), rig(1, { heartbeats: minutely(15 * MIN) })]);
      expect(rulesOf(findings)).toEqual(["rig_silent rig:rig-3 warning"]);
    });
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
    const justSeated = { ...SEATED, startedAt: NOW - 2 * MIN };
    expect(evaluate([rig(1, { seated: justSeated, heartbeats: disconnectedFor(10 * MIN) })])).toEqual([]);
  });

  it("does not fire with nobody seated, or on a rig not reading iRacing", () => {
    expect(evaluate([rig(1, { heartbeats: disconnectedFor(10 * MIN) })])).toEqual([]);
    const none = minutely(14 * MIN, 0, () => ({ telemetryMode: "none", simConnected: false }));
    expect(evaluate([rig(1, { seated: SEATED, heartbeats: none })])).toEqual([]);
  });

  it("does not count the time since the rig went silent as time disconnected", () => {
    const heartbeats = minutely(14 * MIN + 30 * S, 3 * MIN + 30 * S, (ago) => ({ simConnected: ago > 4 * MIN }));
    expect(rulesOf(evaluate([rig(1, { seated: SEATED, heartbeats })]))).toEqual([
      "rig_silent rig:rig-1 urgent",
    ]);
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

  it("places each start on the server's clock, whatever the rig's clock says", () => {
    // The rig's clock runs ten minutes slow, so its "20 minutes ago" is ten.
    const slow = [10, 8, 6].map((m) => {
      const h = hb(m * MIN - 20 * S, { processStartedAt: NOW - (m + 10) * MIN, sequence: 1 });
      return { ...h, sentAt: h.receivedAt - 10 * MIN, clockSkewMs: 10 * MIN };
    });
    expect(rulesOf(evaluate([rig(1, { heartbeats: slow })]))).toContain(
      "agent_restarting rig:rig-1 urgent",
    );
  });

  it("does not count a long-running process whose clock was set back while it ran", () => {
    // Started 50 min ago on a clock two hours fast, since corrected.
    const corrected = minutely(14 * MIN, 9 * MIN, () => ({ processStartedAt: NOW + 70 * MIN }));
    expect(evaluate([rig(1, { heartbeats: [...corrected, ...starts(7, 2)] })])).toEqual([]);
  });

  it("holds while the rig's standing state is a goodbye from the loop", () => {
    const loop = [
      ...starts(12, 7),
      hb(90 * S, { processStartedAt: NOW - 2 * MIN, sequence: 1 }),
      hb(30 * S, { processStartedAt: NOW - 2 * MIN, sequence: 2, shuttingDown: true }),
    ];
    expect(rulesOf(evaluate([rig(1, { heartbeats: loop })]))).toEqual([
      "agent_restarting rig:rig-1 urgent",
    ]);
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

  it("17 holds an open alert through a goodbye, whatever the goodbye says", () => {
    const heartbeats = [
      ...minutely(14 * MIN, 2 * MIN, () => ({ missingVariables: ["PlayerCarIdx"] })),
      hb(MIN, { missingVariables: [], shuttingDown: true }),
    ];
    const open = [{ rule: "missing_variables" as const, subject: rigSubject("rig-1") }];
    expect(rulesOf(evaluate([rig(1, { heartbeats })], open))).toEqual([
      "missing_variables rig:rig-1 warning",
    ]);
    expect(evaluate([rig(1, { heartbeats })])).toEqual([]);
  });

  it("stay quiet once the agent has said goodbye", () => {
    const bye = latest({ telemetryFaulted: true, checkout: "not_queued", missingVariables: ["X"], shuttingDown: true });
    expect(evaluate([rig(1, { heartbeats: bye })])).toEqual([]);
  });
});

describe("rules 12, 17 and 18 across a restart", () => {
  const subject = rigSubject("rig-1");
  const open = [
    { rule: "clock_skew" as const, subject },
    { rule: "missing_variables" as const, subject },
    { rule: "footprint_high" as const, subject },
  ];
  const ailing = { clockSkewMs: 6 * MIN, missingVariables: ["PlayerCarIdx"], agentMemoryMb: 180 };

  it("holds open alerts while the standing state is a goodbye", () => {
    const heartbeats = [...minutely(14 * MIN, 2 * MIN, () => ailing), hb(MIN, { shuttingDown: true })];
    expect(rulesOf(evaluate([rig(1, { heartbeats })], open))).toEqual([
      "clock_skew rig:rig-1 urgent",
      "footprint_high rig:rig-1 warning",
      "missing_variables rig:rig-1 warning",
    ]);
  });

  it("does not open them from a goodbye", () => {
    const heartbeats = [...minutely(14 * MIN, 2 * MIN, () => ailing), hb(MIN, { ...ailing, shuttingDown: true })];
    expect(evaluate([rig(1, { heartbeats })])).toEqual([]);
  });

  it("clears them on the next process's live heartbeat that no longer shows them", () => {
    const heartbeats = [
      ...minutely(14 * MIN, 5 * MIN, () => ailing),
      hb(4 * MIN, { ...ailing, shuttingDown: true }),
      ...minutely(MIN, 0, () => ({ processStartedAt: NOW - 90 * S, sequence: 1 })),
    ];
    expect(evaluate([rig(1, { heartbeats })], open)).toEqual([]);
  });

  /** What the agent really sends before iRacing attaches, and after it goes. */
  const detached = { simConnected: false, missingVariables: [] };

  it("holds 17 through the next process's heartbeats from before iRacing attaches", () => {
    const heartbeats = [
      ...minutely(14 * MIN, 5 * MIN, () => ({ missingVariables: ["PlayerCarIdx"] })),
      hb(4 * MIN, { missingVariables: ["PlayerCarIdx"], shuttingDown: true }),
      ...minutely(MIN, 0, () => ({ ...detached, processStartedAt: NOW - 90 * S, sequence: 1 })),
    ];
    expect(rulesOf(evaluate([rig(1, { heartbeats })], open))).toEqual([
      "missing_variables rig:rig-1 warning",
    ]);
    const attachedClean = [...heartbeats, hb(0, { processStartedAt: NOW - 90 * S, sequence: 3 })];
    expect(evaluate([rig(1, { heartbeats: attachedClean })], open)).toEqual([]);
  });

  it("holds 17 when iRacing closes, and while no attached heartbeat is in view", () => {
    const closed = [
      ...minutely(14 * MIN, 2 * MIN, () => ({ missingVariables: ["PlayerCarIdx"] })),
      ...minutely(MIN, 0, () => detached),
    ];
    expect(rulesOf(evaluate([rig(1, { heartbeats: closed })], open))).toEqual([
      "missing_variables rig:rig-1 warning",
    ]);
    const neverAttached = minutely(14 * MIN, 0, () => detached);
    const [held] = evaluate([rig(1, { heartbeats: neverAttached })], open);
    expect(held!.detail.headline).toBe(
      "Rig 01: this iRacing build does not publish some variables the agent reads",
    );
    expect(evaluate([rig(1, { heartbeats: neverAttached })])).toEqual([]);
  });

  // A heartbeat sent before the one standing can arrive after it (a retry, or
  // one in flight when the next or the goodbye went). It must not stand in for
  // the rig's newer report, or the open alert recovers and then fires again.
  it("holds 17 when an earlier, clean heartbeat arrives after the one that showed it", () => {
    const heartbeats = [
      ...minutely(14 * MIN, 2 * MIN, (ago) => ({ sequence: 100 - ago / MIN })),
      hb(MIN, { sequence: 102, missingVariables: ["PlayerCarIdx"] }),
      hb(30 * S, { sequence: 101, sentAt: NOW - 2 * MIN }),
    ];
    expect(rulesOf(evaluate([rig(1, { heartbeats })], open))).toEqual([
      "missing_variables rig:rig-1 warning",
    ]);
  });

  it("holds 18 when a healthy heartbeat sent before the goodbye arrives after it", () => {
    const heartbeats = [
      ...minutely(14 * MIN, 3 * MIN, (ago) => ({ sequence: 100 - ago / MIN })),
      hb(2 * MIN, { sequence: 102, agentMemoryMb: 200 }),
      hb(MIN, { sequence: 103, agentMemoryMb: 200, shuttingDown: true }),
      hb(30 * S, { sequence: 101, sentAt: NOW - 3 * MIN }),
    ];
    expect(rulesOf(evaluate([rig(1, { heartbeats })], open))).toEqual([
      "footprint_high rig:rig-1 warning",
    ]);
  });

  it("does not let an idle heartbeat from before the busy run cut it by arriving late", () => {
    const busy = minutely(10 * MIN, 0, (ago) => ({ sequence: 100 - ago / MIN, agentCpuPercent: 4 }));
    // Sent twenty minutes ago, before the run began; lands three minutes ago.
    const late = hb(3 * MIN - 5 * S, { sequence: 80, sentAt: NOW - 20 * MIN, agentCpuPercent: 0.2 });
    const heartbeats = [...busy.slice(0, 8), late, ...busy.slice(8)];
    expect(rulesOf(evaluate([rig(1, { heartbeats })]))).toEqual(["footprint_high rig:rig-1 warning"]);
  });

  it("holds 18 on CPU over the line without a fresh five-minute run, as after a restart", () => {
    const heartbeats = [
      ...minutely(14 * MIN, 3 * MIN),
      hb(2 * MIN, { shuttingDown: true }),
      ...minutely(MIN, 0, () => ({ ...detached, agentCpuPercent: 4, processStartedAt: NOW - 90 * S, sequence: 1 })),
    ];
    expect(rulesOf(evaluate([rig(1, { heartbeats })], open))).toEqual([
      "footprint_high rig:rig-1 warning",
    ]);
    expect(evaluate([rig(1, { heartbeats })])).toEqual([]);
  });
});

describe("driver names in alerts", () => {
  const silentWith = (driverStatus: string) =>
    rig(1, {
      heartbeats: minutely(20 * MIN, 3 * MIN),
      seated: { ...SEATED, driverStatus },
    });

  it("names an active driver", () => {
    const [silent] = evaluate([silentWith("active"), rig(2)]);
    expect(silent!.detail.headline).toBe("Rig 01 has been silent for 3 min with Matt G signed in");
  });

  it.each(["name_flagged", "banned"])("never names a %s driver, in the headline or the fields", (status) => {
    const [silent] = evaluate([silentWith(status), rig(2)]);
    expect(silent!.detail.headline).toBe(
      "Rig 01 has been silent for 3 min with a driver (name under review) signed in",
    );
    expect(JSON.stringify(silent!.detail)).not.toContain("Matt G");
  });

  it("never names one in the iRacing alert either", () => {
    const heartbeats = minutely(14 * MIN, 0, () => ({ simConnected: false }));
    const findings = evaluate([rig(1, { heartbeats, seated: { ...SEATED, driverStatus: "name_flagged" } })]);
    expect(only(findings, "sim_disconnected")!.detail.headline).toBe(
      "Rig 01: iRacing not connected for 14 min while a driver (name under review) is signed in",
    );
    expect(JSON.stringify(findings)).not.toContain("Matt G");
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

  it("does not count the time since the rig went silent as time busy", () => {
    const heartbeats = minutely(14 * MIN, 6 * MIN, (ago) => ({ agentCpuPercent: ago === 6 * MIN ? 4 : 0.2 }));
    expect(only(evaluate([rig(1, { heartbeats })]), "footprint_high")).toBeUndefined();
  });

  it("clears when the latest heartbeat is back under both", () => {
    const heartbeats = minutely(14 * MIN, 0, (ago) => ({ agentCpuPercent: ago > 0 ? 4 : 0.3 }));
    expect(evaluate([rig(1, { heartbeats })])).toEqual([]);
  });
});

const COMBO: FeaturedCombo = { trackName: "Circuit of the Americas", trackConfig: "Grand Prix", carName: "FIA F4" };
const DRIVER = { id: "driver-matt", name: "Matt G", status: "active" };

/** A lap stored `ago` before now on `rig`, valid and owned by Matt G unless told otherwise. */
function lap(rigNumber: number, ago: number, overrides: Partial<LapSnapshot> = {}): LapSnapshot {
  return {
    id: `lap-${++nextId}`,
    rigId: `rig-${rigNumber}`,
    receivedAt: NOW - ago,
    driver: DRIVER,
    combo: COMBO,
    lapTimeMs: 137_000,
    valid: true,
    invalidReason: null,
    unattributedCause: null,
    ...overrides,
  };
}

/** A lap the agent said nobody was checked in for. */
const nobodyLap = (rigNumber: number, ago: number) =>
  lap(rigNumber, ago, {
    driver: null,
    valid: false,
    invalidReason: "UNATTRIBUTED",
    unattributedCause: "nobody_checked_in",
  });

describe("event mode", () => {
  it("is off until plan PR 4 supplies it, so rules 5a and 7 stay warnings", () => {
    expect(inEventMode(snapshotOf([rig(1)]))).toBe(false);
  });
});

describe("rule 5a: laps with nobody signed in", () => {
  it("warns on two such laps inside ten minutes", () => {
    const findings = evaluate([rig(1)], [], { laps: [nobodyLap(1, 6 * MIN), nobodyLap(1, 2 * MIN)] });
    expect(rulesOf(findings)).toEqual(["unattributed_laps rig:rig-1 warning"]);
    expect(findings[0]!.detail.headline).toBe(
      "Rig 01: 2 laps in the last 10 min landed with nobody signed in - they will not rank; laps rank again once someone signs in on the rig",
    );
    expect(findings[0]!.detail.fields).toContainEqual({ name: "Laps with nobody signed in", value: "2" });
  });

  it("does not fire on one, on two far apart, or on other kinds of unattributed lap", () => {
    expect(evaluate([rig(1)], [], { laps: [nobodyLap(1, 2 * MIN)] })).toEqual([]);
    expect(evaluate([rig(1)], [], { laps: [nobodyLap(1, 12 * MIN), nobodyLap(1, 2 * MIN)] })).toEqual([]);
    const skewed = (ago: number) => ({ ...nobodyLap(1, ago), unattributedCause: "outside_assignment_window" });
    expect(evaluate([rig(1)], [], { laps: [skewed(4 * MIN), skewed(2 * MIN)] })).toEqual([]);
  });

  it("counts each rig's laps on their own", () => {
    expect(evaluate([rig(1), rig(2)], [], { laps: [nobodyLap(1, 4 * MIN), nobodyLap(2, 2 * MIN)] })).toEqual([]);
  });

  it("holds an open alert for fifteen minutes after the last one", () => {
    const open = [{ rule: "unattributed_laps" as const, subject: rigSubject("rig-1") }];
    const laps = [nobodyLap(1, 14 * MIN)];
    expect(rulesOf(evaluate([rig(1)], open, { laps }))).toEqual(["unattributed_laps rig:rig-1 warning"]);
    expect(evaluate([rig(1)], [], { laps })).toEqual([]);
  });

  it("clears as soon as an attributed lap lands after them", () => {
    const open = [{ rule: "unattributed_laps" as const, subject: rigSubject("rig-1") }];
    const laps = [nobodyLap(1, 6 * MIN), nobodyLap(1, 4 * MIN), lap(1, MIN)];
    expect(evaluate([rig(1)], open, { laps })).toEqual([]);
  });

  it("judges laps from an agent too old to heartbeat anything but its version", () => {
    const v1 = minutely(14 * MIN, 0, () => ({ telemetryMode: null, simConnected: null, agentVersion: CURRENT_AGENT_VERSION }));
    const findings = evaluate([rig(1, { heartbeats: v1 })], [], { laps: [nobodyLap(1, 3 * MIN), nobodyLap(1, MIN)] });
    expect(rulesOf(findings)).toEqual(["unattributed_laps rig:rig-1 warning"]);
  });
});

describe("rule 5b: unusually long stint", () => {
  const seatedFor = (d: number) => ({ ...SEATED, startedAt: NOW - d });

  it("warns once a driver has been seated past the threshold", () => {
    const findings = evaluate([rig(1, { seated: seatedFor(2 * 60 * MIN + 5 * MIN) })]);
    expect(rulesOf(findings)).toEqual(["long_stint rig:rig-1 warning"]);
    expect(findings[0]!.detail.headline).toBe(
      "Rig 01: Matt G has been signed in for 2 h 5 min - still driving, or a missed sign-out?",
    );
  });

  it("reads the threshold staff set, not a fixed two hours", () => {
    const seated = seatedFor(100 * MIN);
    expect(evaluate([rig(1, { seated })])).toEqual([]);
    expect(rulesOf(evaluate([rig(1, { seated })], [], { longStintMinutes: 90 }))).toEqual([
      "long_stint rig:rig-1 warning",
    ]);
  });

  it("holds while the stint stays open, even on a rig that has gone quiet, and clears when it ends", () => {
    const open = [{ rule: "long_stint" as const, subject: rigSubject("rig-1") }];
    const quiet = rig(1, { seated: seatedFor(3 * 60 * MIN), heartbeats: minutely(60 * MIN, 50 * MIN) });
    expect(rulesOf(evaluate([quiet], open))).toContain("long_stint rig:rig-1 warning");
    expect(evaluate([rig(1)], open)).toEqual([]);
  });

  it("stays quiet about a stint left open at closing until the rig is switched on again", () => {
    const seated = seatedFor(3 * 60 * MIN);
    const closed = [...minutely(90 * MIN, 61 * MIN), hb(60 * MIN, { shuttingDown: true })];
    expect(only(evaluate([rig(1, { seated, heartbeats: closed })]), "long_stint")).toBeUndefined();
    const dark = minutely(90 * MIN, 60 * MIN);
    expect(only(evaluate([rig(1, { seated, heartbeats: dark })]), "long_stint")).toBeUndefined();
    const backOn = [...closed, ...minutely(2 * MIN)];
    expect(rulesOf(evaluate([rig(1, { seated, heartbeats: backOn })]))).toEqual(["long_stint rig:rig-1 warning"]);
  });

  it("never names a driver whose name is under review", () => {
    const flagged = { ...seatedFor(3 * 60 * MIN), driverStatus: "name_flagged" };
    const finding = only(evaluate([rig(1, { seated: flagged })]), "long_stint")!;
    expect(finding.detail.headline).toContain("a driver (name under review)");
    expect(finding.detail.driver).toBeNull();
  });
});

describe("rule 6: repeated sign-in failures", () => {
  /** One refusal reported at each of `at`, numbered as rig-agent/0.5-monitor numbers them. */
  const failing = (at: number[], kinds: string[] = ["wrong_pin_or_name"]) =>
    minutely(14 * MIN, 0, (ago) =>
      at.includes(ago) ? { signInFailures: 1, signInFailureKinds: kinds, signInFailureSeqs: [ago] } : {},
    );

  it("warns on three inside five minutes, naming the kinds", () => {
    const heartbeats = minutely(14 * MIN, 0, (ago) =>
      ago === 4 * MIN
        ? {
            signInFailures: 2,
            signInFailureKinds: ["wrong_pin_or_name", "wrong_pin_or_name"],
            signInFailureSeqs: [1, 2],
          }
        : ago === MIN
          ? { signInFailures: 1, signInFailureKinds: ["locked"], signInFailureSeqs: [3] }
          : {},
    );
    const findings = evaluate([rig(1, { heartbeats })]);
    expect(rulesOf(findings)).toEqual(["sign_in_failures rig:rig-1 warning"]);
    expect(findings[0]!.detail.headline).toBe(
      "Rig 01: 3 walk-up sign-ins refused in 5 min (wrong PIN or name, locked out)",
    );
  });

  it("does not fire on two, or on three spread past five minutes", () => {
    expect(evaluate([rig(1, { heartbeats: failing([3 * MIN, MIN]) })])).toEqual([]);
    expect(evaluate([rig(1, { heartbeats: failing([8 * MIN, 3 * MIN, MIN]) })])).toEqual([]);
  });

  it("counts failures re-reported after a lost answer once, by the agent's own failure sequence", () => {
    // Two refusals reported, the answer lost, and the retry ten seconds later
    // reporting the same two under a new heartbeat sequence.
    const reported = { signInFailures: 2, signInFailureKinds: ["wrong_pin_or_name"], signInFailureSeqs: [4, 5] };
    const heartbeats = [
      ...minutely(14 * MIN, 3 * MIN),
      hb(2 * MIN + 50 * S, { ...reported, sequence: 1_001 }),
      hb(2 * MIN + 40 * S, { ...reported, sequence: 1_002 }),
      ...minutely(MIN),
    ];
    expect(evaluate([rig(1, { heartbeats })])).toEqual([]);

    const third = hb(30 * S, { signInFailures: 1, signInFailureKinds: ["locked"], signInFailureSeqs: [9], sequence: 1_003 });
    const findings = evaluate([rig(1, { heartbeats: [...heartbeats, third].sort((a, b) => a.receivedAt - b.receivedAt) })]);
    expect(findings[0]!.detail.headline).toBe(
      "Rig 01: 3 walk-up sign-ins refused in 5 min (wrong PIN or name, locked out)",
    );
  });

  it("keys the failure sequence by agent process, since a restarted agent counts from 1 again", () => {
    const reported = (ago: number, processStartedAt: number, signInFailureSeqs: number[]) =>
      hb(ago, { processStartedAt, signInFailures: signInFailureSeqs.length, signInFailureKinds: ["other"], signInFailureSeqs });
    const heartbeats = [reported(3 * MIN, STARTED, [1, 2]), reported(MIN, NOW - 2 * MIN, [1, 2])];
    expect(rulesOf(evaluate([rig(1, { heartbeats })]))).toEqual(["sign_in_failures rig:rig-1 warning"]);
  });

  it("holds while any came inside ten minutes, and clears after ten quiet ones", () => {
    const open = [{ rule: "sign_in_failures" as const, subject: rigSubject("rig-1") }];
    expect(rulesOf(evaluate([rig(1, { heartbeats: failing([9 * MIN]) })], open))).toEqual([
      "sign_in_failures rig:rig-1 warning",
    ]);
    expect(evaluate([rig(1, { heartbeats: failing([11 * MIN]) })], open)).toEqual([]);
  });

  it("counts the refusals a goodbye reports", () => {
    const heartbeats = [
      ...minutely(14 * MIN, MIN),
      hb(0, { signInFailures: 3, signInFailureKinds: ["unreachable"], signInFailureSeqs: [1, 2, 3], shuttingDown: true }),
    ];
    expect(rulesOf(evaluate([rig(1, { heartbeats })]))).toEqual(["sign_in_failures rig:rig-1 warning"]);
  });

  it("does not count an agent's reports that carry no failure sequences, which it replays after a lost answer", () => {
    // rig-agent/0.4-monitor: two refusals reported, the answer lost, and the
    // same two reported again - four by count, two in fact.
    const legacy = { signInFailures: 2, signInFailureKinds: ["wrong_pin_or_name"], signInFailureSeqs: null };
    const heartbeats = [
      ...minutely(14 * MIN, 3 * MIN),
      hb(2 * MIN + 50 * S, { ...legacy, agentVersion: "rig-agent/0.4-monitor", sequence: 1_001 }),
      hb(2 * MIN + 40 * S, { ...legacy, agentVersion: "rig-agent/0.4-monitor", sequence: 1_002 }),
      ...minutely(MIN, 0, () => ({ agentVersion: "rig-agent/0.4-monitor" })),
    ];
    const findings = evaluate([rig(1, { heartbeats })]);
    expect(only(findings, "sign_in_failures")).toBeUndefined();
    // Rule 11 is what asks for the build that brings the rig into rule 6.
    expect(only(findings, "agent_outdated")).toBeDefined();
  });
});

describe("rule 7: wrong car or track", () => {
  const inSession = (session: FeaturedCombo | null) => minutely(14 * MIN, 0, () => ({ session }));
  const wrongCar = { ...COMBO, carName: "Mazda MX-5" };
  const combo = { featuredCombo: COMBO };

  it("warns when a seated rig's session is not today's combo, saying which part", () => {
    const findings = evaluate([rig(1, { seated: SEATED, heartbeats: inSession(wrongCar) })], [], combo);
    expect(rulesOf(findings)).toEqual(["wrong_combo rig:rig-1 warning"]);
    expect(findings[0]!.detail.headline).toBe(
      "Rig 01 is in an iRacing session on the wrong car for today's featured combo while Matt G is signed in - their laps will not rank",
    );
    expect(findings[0]!.detail.fields).toContainEqual({
      name: "Today's combo",
      value: "Circuit of the Americas Grand Prix · FIA F4",
    });
  });

  it("never puts the rig's own session strings in the alert", () => {
    const findings = evaluate([rig(1, { seated: SEATED, heartbeats: inSession(wrongCar) })], [], combo);
    expect(JSON.stringify(findings)).not.toContain("Mazda");
  });

  it("judges the layout as ingestion does: a missing config and an empty one are the same", () => {
    const noConfig = { featuredCombo: { ...COMBO, trackConfig: null } };
    const empty = inSession({ ...COMBO, trackConfig: "" });
    expect(evaluate([rig(1, { seated: SEATED, heartbeats: empty })], [], noConfig)).toEqual([]);
    const otherLayout = inSession({ ...COMBO, trackConfig: "National" });
    expect(only(evaluate([rig(1, { seated: SEATED, heartbeats: otherLayout })], [], combo), "wrong_combo")!.detail.headline)
      .toContain("wrong track or layout");
  });

  it("does not judge a session with nobody seated, a session on a silent rig, or a day with no combo", () => {
    expect(evaluate([rig(1, { heartbeats: inSession(wrongCar) })], [], combo)).toEqual([]);
    const quiet = minutely(14 * MIN, 4 * MIN, () => ({ session: wrongCar }));
    expect(only(evaluate([rig(1, { seated: SEATED, heartbeats: quiet })], [], combo), "wrong_combo")).toBeUndefined();
    expect(evaluate([rig(1, { seated: SEATED, heartbeats: inSession(wrongCar) })])).toEqual([]);
  });

  it("warns when the rig's last three laps were all refused for the combo", () => {
    const rejected = (ago: number) => lap(1, ago, { valid: false, invalidReason: "WRONG_CAR" });
    const laps = [rejected(9 * MIN), rejected(6 * MIN), rejected(3 * MIN)];
    const findings = evaluate([rig(1)], [], { ...combo, laps });
    expect(rulesOf(findings)).toEqual(["wrong_combo rig:rig-1 warning"]);
    expect(findings[0]!.detail.headline).toBe(
      "Rig 01: its last 3 laps were on the wrong car for today's featured combo, so none of them rank",
    );
    expect(findings[0]!.detail.fields).toContainEqual({ name: "Combo-rejected laps", value: "3" });
  });

  it("does not count two, laps refused for incidents, or laps past fifteen minutes", () => {
    const rejected = (ago: number, reason = "WRONG_TRACK_CONFIGURATION") =>
      lap(1, ago, { valid: false, invalidReason: reason });
    expect(evaluate([rig(1)], [], { ...combo, laps: [rejected(6 * MIN), rejected(3 * MIN)] })).toEqual([]);
    const incidents = [rejected(9 * MIN), rejected(6 * MIN, "INCIDENT_LIMIT_EXCEEDED"), rejected(3 * MIN)];
    expect(evaluate([rig(1)], [], { ...combo, laps: incidents })).toEqual([]);
    expect(evaluate([rig(1)], [], { ...combo, laps: [rejected(16 * MIN), rejected(6 * MIN), rejected(3 * MIN)] })).toEqual([]);
  });

  describe("with both its signals in view, the newest decides", () => {
    const rejected = (ago: number) => lap(1, ago, { valid: false, invalidReason: "WRONG_CAR" });
    const streak = [rejected(9 * MIN), rejected(6 * MIN), rejected(3 * MIN)];
    /** Heartbeats every minute up to now, the session wrong until `fixedAgo` and right after it. */
    const fixedAt = (fixedAgo: number) =>
      minutely(14 * MIN, 0, (ago) => ({ session: ago > fixedAgo ? wrongCar : COMBO }));

    it("keeps the rig's current wrong session over an earlier right one that arrived after it", () => {
      // Sequence 1002 (wrong car) lands first; 1001 (right car), sent before
      // it, is delayed and lands 30 s later. The rig is on the wrong car.
      const heartbeats = [
        ...minutely(14 * MIN, 2 * MIN, () => ({ session: wrongCar })),
        hb(MIN, { sequence: 1_002, session: wrongCar }),
        hb(30 * S, { sequence: 1_001, session: COMBO }),
      ];
      expect(rulesOf(evaluate([rig(1, { seated: SEATED, heartbeats })], [], combo))).toEqual([
        "wrong_combo rig:rig-1 warning",
      ]);
    });

    it("clears when the session is put right, with the refused laps still in view", () => {
      expect(evaluate([rig(1, { seated: SEATED, heartbeats: fixedAt(2 * MIN) })], [], { ...combo, laps: streak })).toEqual([]);
    });

    it("stays clear once the session was put right and the seat empties or the sim closes", () => {
      const signedOut = rig(1, { heartbeats: fixedAt(2 * MIN) });
      const quit = rig(1, {
        seated: SEATED,
        heartbeats: [...fixedAt(2 * MIN).slice(0, -1), hb(0, { simConnected: false, session: null })],
      });
      const dark = rig(1, {
        seated: SEATED,
        heartbeats: [...minutely(14 * MIN, 3 * MIN, () => ({ session: wrongCar })), hb(150 * S, { session: COMBO })],
      });
      for (const after of [signedOut, quit, dark]) {
        expect(only(evaluate([after], [], { ...combo, laps: streak }), "wrong_combo")).toBeUndefined();
      }
    });

    it("clears when a valid lap lands after a wrong session, before the next heartbeat says so", () => {
      const heartbeats = minutely(14 * MIN, MIN, () => ({ session: wrongCar }));
      const laps = [...streak, lap(1, 30 * S)];
      expect(evaluate([rig(1, { seated: SEATED, heartbeats })], [], { ...combo, laps })).toEqual([]);
    });

    it("opens again on a wrong session heard after the lap that cleared it", () => {
      const heartbeats = minutely(14 * MIN, 0, () => ({ session: wrongCar }));
      const laps = [...streak, lap(1, 30 * S)];
      const findings = evaluate([rig(1, { seated: SEATED, heartbeats })], [], { ...combo, laps });
      expect(rulesOf(findings)).toEqual(["wrong_combo rig:rig-1 warning"]);
      expect(findings[0]!.detail.headline).toContain("is in an iRacing session on the wrong car");
    });

    it("opens again on a refused run after the session was put right", () => {
      const later = [rejected(2 * MIN), rejected(MIN), rejected(30 * S)];
      const heartbeats = minutely(14 * MIN, MIN, (ago) => ({ session: ago > 10 * MIN ? wrongCar : COMBO }));
      const findings = evaluate([rig(1, { seated: SEATED, heartbeats })], [], { ...combo, laps: later });
      expect(findings[0]!.detail.headline).toBe(
        "Rig 01: its last 3 laps were on the wrong car for today's featured combo, so none of them rank",
      );
    });
  });

  it("clears when a valid lap lands, or when the session matches", () => {
    const rejected = (ago: number) => lap(1, ago, { valid: false, invalidReason: "WRONG_CAR" });
    const laps = [rejected(9 * MIN), rejected(6 * MIN), rejected(3 * MIN), lap(1, MIN)];
    expect(evaluate([rig(1)], [], { ...combo, laps })).toEqual([]);
    expect(evaluate([rig(1, { seated: SEATED, heartbeats: inSession(COMBO) })], [], combo)).toEqual([]);
  });
});

describe("rule 11: outdated rig agent", () => {
  const running = (agentVersion: string | null) => minutely(14 * MIN, 0, () => ({ agentVersion }));

  const outdated = `agent_outdated ${outdatedAgentSubject("rig-1")} warning`;

  it("warns about a rig on any build but the current one, once per rig per version", () => {
    const findings = evaluate([rig(1, { heartbeats: running("rig-agent/0.3-event") })]);
    expect(rulesOf(findings)).toEqual([outdated]);
    expect(findings[0]!.subject).toBe(`rig:rig-1|${CURRENT_AGENT_VERSION}`);
    expect(findings[0]!.detail.headline).toBe(
      `Rig 01 runs an outdated rig agent - install ${CURRENT_AGENT_VERSION} on it`,
    );
    expect(findings[0]!.detail.fields).toContainEqual({ name: "Agent", value: "rig-agent/0.3-event" });
  });

  it("clears once the rig reports the current build, and says nothing for a rig that reports none", () => {
    expect(evaluate([rig(1, { heartbeats: running(CURRENT_AGENT_VERSION) })])).toEqual([]);
    expect(evaluate([rig(1, { heartbeats: running(null) })])).toEqual([]);
  });

  it("does not open on a goodbye or a silent rig, but holds an alert already open through either", () => {
    const goodbye = [...running("rig-agent/0.3-event"), hb(-S, { agentVersion: "rig-agent/0.3-event", shuttingDown: true })];
    const closed = rig(1, { heartbeats: goodbye, lastSeenAt: NOW });
    const dark = rig(1, { heartbeats: minutely(60 * MIN, 30 * MIN, () => ({ agentVersion: "rig-agent/0.3-event" })) });
    const open = [{ rule: "agent_outdated" as const, subject: outdatedAgentSubject("rig-1") }];
    for (const off of [closed, dark]) {
      expect(only(evaluate([off]), "agent_outdated")).toBeUndefined();
      expect(rulesOf(evaluate([off], open).filter((f) => f.rule === "agent_outdated"))).toEqual([outdated]);
    }
  });

  it("posts nothing for switched-off rigs when a new build is released after closing", () => {
    const closed = (n: number) =>
      rig(n, {
        heartbeats: [
          ...minutely(90 * MIN, 61 * MIN, () => ({ agentVersion: "rig-agent/0.3-event" })),
          hb(60 * MIN, { agentVersion: "rig-agent/0.3-event", shuttingDown: true }),
        ],
      });
    // Rig 1 was told to install the previous release; rig 2 never was.
    const previous = [{ rule: "agent_outdated" as const, subject: "rig:rig-1|rig-agent/0.3-previous" }];
    const findings = evaluate([closed(1), closed(2)], previous);
    expect(findings.map((f) => `${f.rule} ${f.subject}`)).toEqual(["agent_outdated rig:rig-1|rig-agent/0.3-previous"]);
  });

  it("opens a fresh alert naming a new release on a live rig, holding the earlier one until the rig is current", () => {
    const previous = [{ rule: "agent_outdated" as const, subject: "rig:rig-1|rig-agent/0.3-previous" }];
    const behind = evaluate([rig(1, { heartbeats: running("rig-agent/0.3-event") })], previous);
    expect(behind.map((f) => f.subject).sort()).toEqual(["rig:rig-1|rig-agent/0.3-previous", outdatedAgentSubject("rig-1")]);
    expect(evaluate([rig(1, { heartbeats: running(CURRENT_AGENT_VERSION) })], previous)).toEqual([]);
  });
});

describe("rule 13: a driver moved rigs while the rig they left is still racing", () => {
  const move = (ago: number, overrides: Partial<MonitorSnapshot["moves"][number]> = {}) => ({
    fromRigId: "rig-1",
    toRigId: "rig-2",
    endedAt: NOW - ago,
    driverName: "Matt G",
    driverStatus: "active",
    ...overrides,
  });
  const racing = minutely(14 * MIN, 0, () => ({ session: COMBO }));
  const idle = minutely(14 * MIN, 0, () => ({ session: null }));

  it("warns when the rig left behind is still in a session with nobody signed in", () => {
    const findings = evaluate([rig(1, { heartbeats: racing }), rig(2, { seated: SEATED })], [], { moves: [move(3 * MIN)] });
    expect(rulesOf(findings)).toEqual(["driver_moved rig:rig-1 warning"]);
    expect(findings[0]!.detail.headline).toBe(
      "Matt G signed in on Rig 02 while still seated on Rig 01, which is still in an iRacing session - is someone driving it without signing in?",
    );
    expect(findings[0]!.detail.driver).toBe("Matt G");
  });

  it("does not fire when the rig left behind is idle, has a new driver, or was last heard before the move", () => {
    expect(evaluate([rig(1, { heartbeats: idle }), rig(2)], [], { moves: [move(3 * MIN)] })).toEqual([]);
    expect(evaluate([rig(1, { heartbeats: racing, seated: SEATED }), rig(2)], [], { moves: [move(3 * MIN)] })).toEqual([]);
    const before = minutely(14 * MIN, 4 * MIN, () => ({ session: COMBO }));
    expect(only(evaluate([rig(1, { heartbeats: before }), rig(2)], [], { moves: [move(3 * MIN)] }), "driver_moved")).toBeUndefined();
  });

  it("holds for ten minutes after the move, then clears", () => {
    const open = [{ rule: "driver_moved" as const, subject: rigSubject("rig-1") }];
    expect(rulesOf(evaluate([rig(1, { heartbeats: idle }), rig(2)], open, { moves: [move(9 * MIN)] }))).toEqual([
      "driver_moved rig:rig-1 warning",
    ]);
    expect(evaluate([rig(1, { heartbeats: racing }), rig(2)], open, { moves: [move(11 * MIN)] })).toEqual([]);
  });

  it("never names a driver whose name is under review", () => {
    const finding = only(
      evaluate([rig(1, { heartbeats: racing }), rig(2)], [], { moves: [move(3 * MIN, { driverStatus: "banned" })] }),
      "driver_moved",
    )!;
    expect(finding.detail.headline).toContain("a driver (name under review) signed in on Rig 02");
    expect(finding.detail.driver).toBeNull();
  });
});

describe("rule 14: implausibly fast lap", () => {
  /** Best laps by `n` other drivers, the fastest 2:00.000. */
  const field = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ combo: COMBO, driverId: `other-${i}`, lapTimeMs: 120_000 + i * 1_000 }));

  it("flags a valid lap more than 3% under the best any other driver had, as its own subject", () => {
    const fast = lap(1, 2 * MIN, { lapTimeMs: 115_000 });
    const findings = evaluate([rig(1)], [], { laps: [fast], lapBests: field(5) });
    expect(rulesOf(findings)).toEqual([`fast_lap rig:rig-1|lap:${fast.id} warning`]);
    expect(findings[0]!.detail.headline).toBe(
      "Rig 01: a 1:55.000 lap by Matt G is 4% under the best any other driver had on this car and track (2:00.000) - worth a look; it ranks unless staff invalidate it",
    );
  });

  it("closes without a recovered message", () => {
    expect(RECOVERS_SILENTLY).toEqual(["fast_lap"]);
  });

  it("does not flag a lap within 3%, or before five other drivers have driven the combo", () => {
    expect(evaluate([rig(1)], [], { laps: [lap(1, MIN, { lapTimeMs: 117_000 })], lapBests: field(5) })).toEqual([]);
    expect(evaluate([rig(1)], [], { laps: [lap(1, MIN, { lapTimeMs: 100_000 })], lapBests: field(4) })).toEqual([]);
  });

  it("compares with other drivers only: a driver beating their own best is not news", () => {
    const own = [...field(4), { combo: COMBO, driverId: DRIVER.id, lapTimeMs: 150_000 }];
    expect(evaluate([rig(1)], [], { laps: [lap(1, MIN, { lapTimeMs: 100_000 })], lapBests: own })).toEqual([]);
  });

  it("compares with the same car and track only", () => {
    const elsewhere = field(5).map((b) => ({ ...b, combo: { ...COMBO, carName: "Mazda MX-5" } }));
    expect(evaluate([rig(1)], [], { laps: [lap(1, MIN, { lapTimeMs: 100_000 })], lapBests: elsewhere })).toEqual([]);
  });

  it("counts recent laps driven before this one, and not the ones after it", () => {
    const others = Array.from({ length: 5 }, (_, i) =>
      lap(2, 10 * MIN - i * S, { driver: { id: `other-${i}`, name: `O${i}`, status: "active" }, lapTimeMs: 120_000 }),
    );
    const fast = lap(1, 5 * MIN, { lapTimeMs: 110_000 });
    const later = lap(2, MIN, { driver: { id: "late", name: "Late", status: "active" }, lapTimeMs: 109_000 });
    const findings = evaluate([rig(1), rig(2)], [], { laps: [...others, fast, later] });
    expect(rulesOf(findings)).toEqual([`fast_lap rig:rig-1|lap:${fast.id} warning`]);
  });

  it("never flags an invalid or unattributed lap", () => {
    const invalid = lap(1, MIN, { lapTimeMs: 100_000, valid: false, invalidReason: "OFF_TRACK" });
    expect(evaluate([rig(1)], [], { laps: [invalid], lapBests: field(5) })).toEqual([]);
  });
});
