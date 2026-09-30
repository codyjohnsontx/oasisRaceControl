import { describe, expect, it } from "vitest";
import type { BoardSnapshot } from "./event-mode";
import type { Heartbeat } from "./rig-state";
import {
  evaluateRules,
  featuredComboSql,
  monitorGap,
  rigSubject,
  VENUE_SUBJECT,
  type Finding,
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

/** 2026-10-04 began at 05:00Z in the venue's zone (CDT). */
const VENUE_DAY_START = Date.parse("2026-10-04T05:00:00Z");
const COMBO = { trackName: "Circuit of the Americas", trackConfig: "Grand Prix", carName: "FIA F4" };

function evaluate(
  rigs: RigSnapshot[],
  openAlerts: Array<{ rule: RuleKey; subject: string }> = [],
  venue: Partial<Omit<MonitorSnapshot, "rigs" | "openAlerts">> = {},
): Finding[] {
  const snapshot: MonitorSnapshot = {
    now: NOW,
    venueDayStart: VENUE_DAY_START,
    featuredCombo: COMBO,
    override: null,
    eventModeSince: null,
    boards: [],
    ...venue,
    rigs,
    openAlerts,
  };
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

// ---- event mode: rules 1 (in event mode), 4, 8a, 8b and 9b ----------------

/** An /tv page as the snapshot holds it: an event board heard 20 s ago by default. */
function board(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    id: "board-1",
    mode: "event",
    host: "cadillac",
    firstSeenAt: NOW - 90 * MIN,
    lastSeenAt: NOW - 20 * S,
    visible: true,
    feedOk: true,
    feedFailures: 0,
    closedAt: null,
    ...overrides,
  };
}
/** An event under way for the last hour. */
const EVENT = { boards: [board()], eventModeSince: NOW - 60 * MIN };

describe("rule 1 in event mode", () => {
  const quiet = (number: number, quietFor: number) =>
    rig(number, { heartbeats: minutely(quietFor + 14 * MIN, quietFor) });
  const venueOpen = [{ rule: "venue_silent" as const, subject: VENUE_SUBJECT }];

  it("is urgent for an empty rig as soon as it passes two minutes, with no correlation wait", () => {
    expect(evaluate([quiet(1, 2 * MIN + 5 * S), rig(2)])).toEqual([]);
    expect(rulesOf(evaluate([quiet(1, 2 * MIN + 5 * S), rig(2)], [], EVENT))).toEqual([
      "rig_silent rig:rig-1 urgent",
    ]);
  });

  it("reads rigs going quiet together mid-event as an outage, not as the venue closing", () => {
    const rigs = [quiet(1, 3 * MIN), quiet(2, 4 * MIN)];
    expect(rulesOf(evaluate(rigs))).toEqual([`venue_silent ${VENUE_SUBJECT} warning`]);
    expect(rulesOf(evaluate(rigs, [], EVENT))).toEqual([
      "rig_silent rig:rig-1 urgent",
      "rig_silent rig:rig-2 urgent",
    ]);
  });

  it("follows a staff override just as it follows the board", () => {
    const on = {
      override: { mode: "on" as const, expiresAt: NOW + 60 * MIN, setBy: "Cody" },
      eventModeSince: NOW - 60 * MIN,
    };
    expect(rulesOf(evaluate([quiet(1, 3 * MIN), rig(2)], [], on))).toEqual(["rig_silent rig:rig-1 urgent"]);
  });

  it("pages about none of the rigs switched off last night when the event board opens in the morning", () => {
    // Power cut at closing, eleven and a half hours ago, no goodbyes: the
    // venue note has been open since.
    const lastNight = [quiet(1, 11.5 * 60 * MIN), quiet(2, 11.5 * 60 * MIN - 2 * MIN), quiet(3, 11.5 * 60 * MIN)];
    const opening = { boards: [board()], eventModeSince: null };
    expect(rulesOf(evaluate(lastNight, venueOpen, opening))).toEqual([`venue_silent ${VENUE_SUBJECT} warning`]);
    expect(rulesOf(evaluate(lastNight, venueOpen, { ...opening, eventModeSince: NOW - 10 * MIN }))).toEqual([
      `venue_silent ${VENUE_SUBJECT} warning`,
    ]);
  });

  it("keeps a rig that went dark with the venue quiet, and pages about one switched on since", () => {
    /** Heard up to `lostAt` ago, then nothing until `backAt` ago, and every minute since. */
    const back = (number: number, lostAt: number, backAt: number) =>
      rig(number, { heartbeats: [...minutely(lostAt + 10 * MIN, lostAt), ...minutely(backAt)] });
    const neverSwitchedOn = quiet(3, 10 * 60 * MIN);
    const switchedOnThenDied = rig(2, {
      heartbeats: [...minutely(10 * 60 * MIN + 10 * MIN, 10 * 60 * MIN), ...minutely(40 * MIN, 5 * MIN)],
    });
    const rigs = [back(1, 10 * 60 * MIN, 45 * MIN), switchedOnThenDied, neverSwitchedOn];
    expect(rulesOf(evaluate(rigs, [], { ...EVENT, eventModeSince: NOW - 30 * MIN }))).toEqual([
      "rig_silent rig:rig-2 urgent",
    ]);
  });

  it("judges a rig that went quiet before the event began as on any other day", () => {
    const early = { ...EVENT, eventModeSince: NOW - 4 * MIN };
    expect(evaluate([quiet(1, 5 * MIN), rig(2)], [], early)).toEqual([]);
    expect(rulesOf(evaluate([quiet(1, 8 * MIN), rig(2)], [], early))).toEqual([
      "rig_silent rig:rig-1 warning",
    ]);
  });
});

describe("rule 4: no featured combo today", () => {
  const SESSION = { trackName: "Circuit of the Americas", trackConfig: "Grand Prix", carName: "FIA F4" };
  const inSession = (number: number, session: Heartbeat["session"] = SESSION) =>
    rig(number, { heartbeats: minutely(14 * MIN, 0, () => ({ session })) });

  it("fires urgent once a rig is in an iRacing session, with the SQL built from that rig's own strings", () => {
    const findings = evaluate([rig(1), inSession(2)], [], { featuredCombo: null });
    expect(rulesOf(findings)).toEqual([`no_featured_combo ${VENUE_SUBJECT} urgent`]);
    const { detail } = findings[0]!;
    expect(detail.headline).toBe(
      "No featured car and track is set for today, and Rig 02 is in an iRacing session - every combo " +
        "ranks together and any incident voids a lap",
    );
    expect(detail.fields).toContainEqual({ name: "Venue date", value: "2026-10-04" });
    expect(detail.fields).toContainEqual({
      name: "Set it (Neon SQL Editor)",
      value:
        "```sql\ninsert into featured_combos (combo_date, track_name, track_config, car_name)\n" +
        "values (venue_today(), 'Circuit of the Americas', 'Grand Prix', 'FIA F4')\n" +
        "on conflict (combo_date) do nothing;\n```",
    });
  });

  it("fires in event mode with no rig in a session yet, pointing at the rig's diagnostic", () => {
    const findings = evaluate([rig(1)], [], { featuredCombo: null, ...EVENT });
    expect(rulesOf(findings)).toEqual([`no_featured_combo ${VENUE_SUBJECT} urgent`]);
    expect(findings[0]!.detail.headline).toContain("and event mode is on");
    expect(findings[0]!.detail.fields.map((f) => f.name)).toEqual(["Venue date", "Set it"]);
  });

  it("does not fire outside event mode while nobody is in a session", () => {
    const idle = rig(1, { heartbeats: minutely(14 * MIN, 0, () => ({ simConnected: true })) });
    const closed = rig(2, {
      heartbeats: [...minutely(14 * MIN, 6 * MIN, () => ({ session: SESSION })), hb(5 * MIN, { shuttingDown: true, session: SESSION })],
    });
    const silent = rig(3, { heartbeats: minutely(20 * MIN, 5 * MIN, () => ({ session: SESSION })) });
    expect(evaluate([idle, closed, silent], [], { featuredCombo: null }).filter((f) => f.rule === "no_featured_combo")).toEqual([]);
  });

  it("escapes a quote in the names iRacing posts", () => {
    expect(featuredComboSql({ trackName: "Rudskogen Motorsenter", trackConfig: null, carName: "Ray's FF1600" })).toBe(
      "insert into featured_combos (combo_date, track_name, track_config, car_name)\n" +
        "values (venue_today(), 'Rudskogen Motorsenter', null, 'Ray''s FF1600')\n" +
        "on conflict (combo_date) do nothing;",
    );
  });

  it("clears once today's combo is set", () => {
    expect(evaluate([inSession(1)], [{ rule: "no_featured_combo", subject: VENUE_SUBJECT }], EVENT)).toEqual([]);
  });
});

describe("rule 8a: TV board went dark", () => {
  const dark = board({ lastSeenAt: NOW - 4 * MIN });

  it("fires urgent when the event board stops without a goodbye, though it no longer holds event mode", () => {
    const findings = evaluate([rig(1)], [], { boards: [dark] });
    expect(rulesOf(findings)).toEqual(["board_dark board:event urgent"]);
    expect(findings[0]!.detail.headline).toBe(
      "Event board (Cadillac) has not been heard from for 4 min - laptop asleep, browser closed, or offline?",
    );
  });

  it("does not fire at three minutes, or for a board that said goodbye - closing the tab is not an alert", () => {
    expect(evaluate([rig(1)], [], { boards: [board({ lastSeenAt: NOW - 3 * MIN })] })).toEqual([]);
    const closed = board({ lastSeenAt: NOW - 10 * MIN, closedAt: NOW - 10 * MIN });
    expect(evaluate([rig(1)], [], { boards: [closed] })).toEqual([]);
  });

  it("does not fire when the browser came back as a new page", () => {
    expect(evaluate([rig(1)], [], { boards: [dark, board({ id: "board-2" })] })).toEqual([]);
  });

  it("forgets yesterday's boards", () => {
    const override = { mode: "on" as const, expiresAt: NOW + MIN, setBy: null };
    const yesterday = board({ lastSeenAt: VENUE_DAY_START - MIN });
    expect(evaluate([rig(1)], [], { boards: [yesterday], override })).toEqual([]);
  });

  it("judges the board the room is watching: a phone left locked on it is not news once the laptop's tab closes", () => {
    const lockedPhone = board({ id: "phone", lastSeenAt: NOW - 90 * MIN });
    const laptop = board({ id: "laptop", lastSeenAt: NOW - 10 * MIN, closedAt: NOW - 10 * MIN });
    expect(evaluate([rig(1)], [], { boards: [lockedPhone, laptop] })).toEqual([]);
    const killedLaptop = board({ id: "laptop", lastSeenAt: NOW - 10 * MIN });
    expect(rulesOf(evaluate([rig(1)], [], { boards: [lockedPhone, killedLaptop] }))).toEqual([
      "board_dark board:event urgent",
    ]);
  });

  it("never watches the shop wall, even with event mode forced on", () => {
    const wall = board({ mode: "rotation", host: null, lastSeenAt: NOW - 30 * MIN });
    const override = { mode: "on" as const, expiresAt: NOW + MIN, setBy: "Cody" };
    expect(evaluate([rig(1)], [], { boards: [wall] })).toEqual([]);
    expect(evaluate([rig(1)], [], { boards: [wall], override, featuredCombo: COMBO })).toEqual([]);
  });

  it("clears when staff stop the event, or a board is heard again", () => {
    const off = { mode: "off" as const, expiresAt: NOW + MIN, setBy: "Cody" };
    expect(evaluate([rig(1)], [], { boards: [dark], override: off })).toEqual([]);
    expect(evaluate([rig(1)], [], { boards: [board()] })).toEqual([]);
  });
});

describe("rule 8b: TV board cannot load its numbers", () => {
  it("fires urgent on three failed loads in a row, in any mode", () => {
    const wall = board({ mode: "rotation", host: null, feedOk: false, feedFailures: 3 });
    const findings = evaluate([rig(1)], [], { boards: [wall] });
    expect(rulesOf(findings)).toEqual(["board_feed_failing board:rotation urgent"]);
    expect(findings[0]!.detail.headline).toBe(
      'Shop wall board: its last 3 loads of the leaderboard failed, so it shows "Reconnecting" - ' +
        "the site answers, the feed does not",
    );
  });

  it("does not fire on two, or for a board that is no longer heard", () => {
    expect(evaluate([rig(1)], [], { boards: [board({ feedFailures: 2 })] })).toEqual([]);
    const gone = board({ feedFailures: 9, lastSeenAt: NOW - 4 * MIN, closedAt: NOW - 4 * MIN });
    expect(evaluate([rig(1)], [], { boards: [gone] })).toEqual([]);
  });

  it("clears on the first load that succeeds", () => {
    const open = [{ rule: "board_feed_failing" as const, subject: "board:event" }];
    expect(evaluate([rig(1)], open, EVENT)).toEqual([]);
  });
});

describe("rule 9b: monitor gap", () => {
  /** An instant on 2026-10-04, venue time (CDT, UTC-5). */
  const venue = (hhmm: string) => Date.parse(`2026-10-04T${hhmm}:00-05:00`);

  it("says nothing without a previous evaluation, or for a gap of ten minutes or less", () => {
    expect(monitorGap(null, venue("15:00"))).toBeNull();
    expect(monitorGap(venue("14:50"), venue("15:00"))).toBeNull();
  });

  it("reports more than ten minutes without an evaluation in venue hours", () => {
    expect(monitorGap(venue("14:49"), venue("15:00"))).toEqual({ from: venue("14:49"), to: venue("15:00") });
  });

  it("does not count the overnight hours, when the clock ticks every thirty minutes on purpose", () => {
    expect(monitorGap(venue("07:30"), venue("08:00"))).toBeNull();
    expect(monitorGap(venue("02:00"), venue("08:10"))).toBeNull();
    expect(monitorGap(venue("02:00"), venue("08:11"))).not.toBeNull();
  });

  it("reports a gap of days at once", () => {
    expect(monitorGap(venue("15:00") - 5 * 86_400_000, venue("15:00"))).not.toBeNull();
  });
});
