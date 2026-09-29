import { holdingSince, rigState, type Heartbeat } from "./rig-state";

/**
 * The rig monitor's rules: given what the database holds right now, which
 * problems exist. Pure - no database, no clock, no network - so every rule is
 * unit-tested from a hand-built snapshot, and so the staff Rig health page can
 * call the same function on the same snapshot as the Discord alerts. That is
 * what keeps a tile's colour and the channel from ever disagreeing: there is
 * one implementation of each rule, here, the same discipline /tv keeps for
 * ranking (AGENTS.md).
 *
 * A rule does not decide whether to post. It says a problem exists, on a
 * subject, at a severity; the alert state (store.ts) turns "exists now and
 * did not before" into exactly one message, and "gone for two evaluations"
 * into exactly one recovery. A rule that needs to know whether its alert is
 * already open - to hold it through a gap, or to clear only below a lower
 * threshold than it fired at - reads that from the snapshot.
 *
 * Rule numbers are the approved plan's (section 6 of the monitoring plan),
 * kept in every message so an alert can be traced back to its rule.
 */

export type Severity = "urgent" | "warning";

export const RULES = {
  rig_silent: { number: "1", title: "Rig silent" },
  venue_silent: { number: "1", title: "Every rig went quiet" },
  sim_disconnected: { number: "2", title: "iRacing not connected while a driver is signed in" },
  laps_stuck: { number: "3a", title: "Laps queued but not reaching the site" },
  laps_refused: { number: "3b", title: "Laps refused by the site" },
  agent_restarting: { number: "10", title: "Rig agent restarting repeatedly" },
  clock_skew: { number: "12", title: "Rig clock is off" },
  telemetry_faulted: { number: "15", title: "Lap reading stopped" },
  checkout_not_saved: { number: "16", title: "Sign-out not saved" },
  missing_variables: { number: "17", title: "iRacing build missing variables" },
  footprint_high: { number: "18", title: "Rig agent footprint high" },
} as const;

export type RuleKey = keyof typeof RULES;

/**
 * Silence that alerts. The agent heartbeats every 60 s and retries a failed
 * heartbeat once, 10 s later, under a 15 s HTTP timeout - so a single blip
 * leaves a gap of at most about 90 s (60 + 15 + 10 + the request), inside
 * this. Two failures in a row cross it, which is the point: that is a rig
 * that cannot reach the site, not a hiccup.
 */
export const SILENT_AFTER_MS = 120_000;
/** A rig quiet for longer than this is not newly silent; it is off for the day. */
export const SILENT_LOOKBACK_MS = 12 * 60 * 60_000;
/**
 * Rigs that go quiet within this of each other, with none left running, read
 * as the venue closing rather than as that many broken rigs - one quiet note
 * instead of a warning per rig. A lone rig nobody is seated on is warned about
 * only once this has passed, because until then it may be the first of a
 * closing. A seated rig never waits: someone is mid-session on it. It is also
 * how long the venue note holds once the first rig is heard again, so rigs
 * still coming back from the same outage are not warned about one by one.
 */
export const CORRELATION_WINDOW_MS = 5 * 60_000;
/** iRacing hides its telemetry while a session loads, for about a minute. */
export const SIM_DISCONNECTED_AFTER_MS = 3 * 60_000;
export const LAP_STUCK_AFTER_S = 120;
export const RESTART_WINDOW_MS = 15 * 60_000;
export const RESTARTS_TO_ALERT = 3;
/**
 * Clock skew. Attribution tolerates 15 minutes (ASSIGNMENT_WINDOW_CLOCK_SKEW
 * in the ingestion route), so 5 is a warning shot well before laps start
 * landing unattributed; it clears only under 2 so a clock hovering near the
 * line does not open and close the alert all evening.
 */
export const CLOCK_SKEW_ALERT_MS = 5 * 60_000;
export const CLOCK_SKEW_CLEAR_MS = 2 * 60_000;
/** R0: the agent must stay out of iRacing's way. Its CPU is % of one core. */
export const FOOTPRINT_CPU_PERCENT = 2;
export const FOOTPRINT_CPU_FOR_MS = 5 * 60_000;
export const FOOTPRINT_MEMORY_MB = 150;

export type RigSnapshot = {
  id: string;
  number: number;
  name: string;
  /** rigs.last_seen_at: the last time the rig reached the site at all. */
  lastSeenAt: number | null;
  /**
   * The rig's open assignment, if a driver is signed in. `driverStatus` is
   * drivers.status: only an active driver's name is ever put in an alert.
   */
  seated: { driverName: string; driverStatus: string; startedAt: number } | null;
  /**
   * The rig's recent heartbeats in arrival order: at least the last
   * fifteen minutes' and the latest one, with the few minutes before it.
   */
  heartbeats: Heartbeat[];
};

export type MonitorSnapshot = {
  /** The database's now(), which every stored time is on. */
  now: number;
  rigs: RigSnapshot[];
  openAlerts: ReadonlyArray<{ rule: string; subject: string }>;
};

/** What an alert's messages say, fixed when the rule fired. */
export type AlertDetail = {
  /** One line: the whole alert, as a phone notification shows it. */
  headline: string;
  /** Which rig, or "Venue". */
  where: string;
  fields: Array<{ name: string; value: string }>;
};

export type Finding = {
  rule: RuleKey;
  subject: string;
  severity: Severity;
  /** How bad, for a rule that can get worse while open; 0 otherwise. */
  level: number;
  detail: AlertDetail;
};

export const VENUE_SUBJECT = "venue";

export function rigSubject(rigId: string): string {
  return `rig:${rigId}`;
}

type Rig = { rig: RigSnapshot; state: Heartbeat | null };

export function evaluateRules(snapshot: MonitorSnapshot): Finding[] {
  const open = new Set(snapshot.openAlerts.map((a) => `${a.rule}|${a.subject}`));
  const isOpen = (rule: RuleKey, subject: string) => open.has(`${rule}|${subject}`);
  const rigs = snapshot.rigs.map((rig) => ({ rig, state: rigState(rig.heartbeats) }));

  return [
    ...silence(snapshot.now, rigs, isOpen),
    ...rigs.flatMap(({ rig, state }) =>
      state ? rigFindings(snapshot.now, rig, state, isOpen) : [],
    ),
  ];
}

/** Rule 1: rigs that stopped reaching the site without saying goodbye. */
function silence(
  now: number,
  rigs: Rig[],
  isOpen: (rule: RuleKey, subject: string) => boolean,
): Finding[] {
  const findings: Finding[] = [];
  // A rig whose standing state is its goodbye was shut down on purpose.
  const reporting = rigs.filter(
    ({ rig, state }) => rig.lastSeenAt !== null && state?.shuttingDown !== true,
  );
  const quietFor = ({ rig }: Rig) => now - rig.lastSeenAt!;
  const live = reporting.filter((r) => quietFor(r) <= SILENT_AFTER_MS);
  const anyLive = live.length > 0;
  const silent = reporting.filter(
    (r) =>
      quietFor(r) > SILENT_AFTER_MS &&
      (quietFor(r) <= SILENT_LOOKBACK_MS || isOpen("rig_silent", rigSubject(r.rig.id))),
  );

  const unexplained: Rig[] = [];
  for (const r of silent) {
    const subject = rigSubject(r.rig.id);
    if (r.rig.seated) {
      findings.push(rigSilent(now, r, "urgent"));
    } else if (isOpen("rig_silent", subject)) {
      findings.push(rigSilent(now, r, "warning"));
    } else {
      unexplained.push(r);
    }
  }

  const lastSeen = unexplained.map(({ rig }) => rig.lastSeenAt!);
  const together =
    unexplained.length >= 2 &&
    Math.max(...lastSeen) - Math.min(...lastSeen) <= CORRELATION_WINDOW_MS;
  const venueOpen = isOpen("venue_silent", VENUE_SUBJECT);
  const firstHeardAgain = Math.min(...live.map(({ rig }) => heardSince(rig.heartbeats)));
  const venueRecovering = anyLive && venueOpen && now - firstHeardAgain < CORRELATION_WINDOW_MS;
  if ((!anyLive && (together || venueOpen)) || venueRecovering) {
    const names = unexplained.map(({ rig }) => rig.name);
    findings.push({
      rule: "venue_silent",
      subject: VENUE_SUBJECT,
      severity: "warning",
      level: 0,
      detail: {
        headline: `${names.length > 0 ? names.join(", ") : "Every rig"} went quiet together - venue closed?`,
        where: "Venue",
        fields: [{ name: "Rigs", value: names.join(", ") || "-" }],
      },
    });
    return findings;
  }

  for (const r of unexplained) {
    if (quietFor(r) >= SILENT_AFTER_MS + CORRELATION_WINDOW_MS) {
      findings.push(rigSilent(now, r, "warning"));
    }
  }
  return findings;
}

/**
 * When the rig was first heard in the unbroken run of heartbeats that ends at
 * its latest: after its last gap long enough to be silence, or its earliest
 * heartbeat here. Never for a rig with none.
 */
function heardSince(heartbeats: readonly Heartbeat[]): number {
  let i = heartbeats.length - 1;
  if (i < 0) return -Infinity;
  while (i > 0 && heartbeats[i]!.receivedAt - heartbeats[i - 1]!.receivedAt <= SILENT_AFTER_MS) i--;
  return heartbeats[i]!.receivedAt;
}

function rigSilent(now: number, { rig, state }: Rig, severity: Severity): Finding {
  const quiet = duration(now - rig.lastSeenAt!);
  const seated = rig.seated ? ` with ${driverName(rig.seated)} signed in` : "";
  return finding("rig_silent", rig, severity, `${rig.name} has been silent for ${quiet}${seated}`, [
    ...rigFields(now, rig, state),
  ]);
}

function rigFindings(
  now: number,
  rig: RigSnapshot,
  state: Heartbeat,
  isOpen: (rule: RuleKey, subject: string) => boolean,
): Finding[] {
  const findings: Finding[] = [];
  const subject = rigSubject(rig.id);
  const fields = rigFields(now, rig, state);

  // Rules 3a and 3b hold through a goodbye: the laps are still in the rig's
  // outbox, and closing the agent does not deliver them. So does rule 10: a
  // restart loop says goodbye on every lap of it.
  if (state.rejectedLaps !== null && state.rejectedLaps > 0) {
    const n = state.rejectedLaps;
    findings.push({
      ...finding(
        "laps_refused",
        rig,
        "urgent",
        `${rig.name}: the site refused ${laps(n)}; ${n === 1 ? "it is" : "they are"} parked on the rig`,
        [...fields, { name: "Parked laps", value: String(n) }],
      ),
      level: n,
    });
  }

  if (lapsStuck(rig.heartbeats, state)) {
    findings.push(
      finding(
        "laps_stuck",
        rig,
        "urgent",
        `${rig.name}: ${laps(state.pendingLaps!)} waiting ${duration(state.oldestPendingAgeS! * 1000)} ` +
          `to reach the site while the rig is online`,
        [...fields, { name: "Queued laps", value: String(state.pendingLaps) }],
      ),
    );
  }

  const starts = recentStarts(now, rig.heartbeats);
  if (starts >= RESTARTS_TO_ALERT) {
    findings.push(
      finding(
        "agent_restarting",
        rig,
        "urgent",
        `${rig.name}: the rig agent started ${starts} times in ${duration(RESTART_WINDOW_MS)}`,
        [...fields, { name: "Starts", value: String(starts) }],
      ),
    );
  }

  // Rules 12, 17 and 18 describe the rig, not the process, so a restart does
  // not end them. They are judged on the rig's last live heartbeat; while the
  // standing state is a goodbye they only hold an alert already open, and the
  // goodbye neither opens nor clears one.
  const live = state.shuttingDown ? lastLive(rig.heartbeats) : state;
  if (live) {
    const properties = rigProperties(rig, live, fields, isOpen);
    findings.push(
      ...(state.shuttingDown ? properties.filter((f) => isOpen(f.rule, subject)) : properties),
    );
  }

  // Everything below is about a running agent; a goodbye ended it.
  if (state.shuttingDown) return findings;

  if (rig.seated && state.telemetryMode === "iracing" && state.simConnected === false) {
    const since = holdingSince(rig.heartbeats, state, (h) => h.simConnected === false)!;
    const from = Math.max(since, rig.seated.startedAt);
    if (state.receivedAt - from >= SIM_DISCONNECTED_AFTER_MS) {
      findings.push(
        finding(
          "sim_disconnected",
          rig,
          "urgent",
          `${rig.name}: iRacing not connected for ${duration(state.receivedAt - from)} while ` +
            `${driverName(rig.seated)} is signed in`,
          fields,
        ),
      );
    }
  }

  if (state.telemetryFaulted === true) {
    findings.push(
      finding(
        "telemetry_faulted",
        rig,
        "urgent",
        `${rig.name}: the rig agent stopped reading laps from iRacing - restart the agent`,
        fields,
      ),
    );
  }

  if (state.checkout === "not_queued") {
    findings.push(
      finding(
        "checkout_not_saved",
        rig,
        "warning",
        `${rig.name}: a sign-out could not be saved on the rig - clear the rig from /staff`,
        fields,
      ),
    );
  }

  return findings;
}

function rigProperties(
  rig: RigSnapshot,
  live: Heartbeat,
  fields: AlertDetail["fields"],
  isOpen: (rule: RuleKey, subject: string) => boolean,
): Finding[] {
  const findings: Finding[] = [];
  const subject = rigSubject(rig.id);

  if (live.clockSkewMs !== null) {
    const skew = Math.abs(live.clockSkewMs);
    const threshold = isOpen("clock_skew", subject) ? CLOCK_SKEW_CLEAR_MS : CLOCK_SKEW_ALERT_MS;
    if (skew >= threshold) {
      // received - sent: positive means the rig stamped an earlier time.
      const side = live.clockSkewMs > 0 ? "behind" : "ahead of";
      findings.push(
        finding(
          "clock_skew",
          rig,
          "urgent",
          `${rig.name}: its clock is ${duration(skew)} ${side} the server's, so its laps ` +
            `may stop reaching the right driver`,
          [...fields, { name: "Clock skew", value: `${Math.round(live.clockSkewMs / 1000)} s` }],
        ),
      );
    }
  }

  if (live.missingVariables.length > 0) {
    findings.push(
      finding(
        "missing_variables",
        rig,
        "warning",
        `${rig.name}: this iRacing build does not publish ${live.missingVariables.join(", ")}`,
        fields,
      ),
    );
  }

  const cpuSince = holdingSince(
    rig.heartbeats,
    live,
    (h) => h.agentCpuPercent !== null && h.agentCpuPercent > FOOTPRINT_CPU_PERCENT,
  );
  const cpuHigh = cpuSince !== null && live.receivedAt - cpuSince >= FOOTPRINT_CPU_FOR_MS;
  const memoryHigh = live.agentMemoryMb !== null && live.agentMemoryMb > FOOTPRINT_MEMORY_MB;
  if (cpuHigh || memoryHigh) {
    const usage = [
      live.agentCpuPercent === null ? null : `${live.agentCpuPercent}% of a core`,
      live.agentMemoryMb === null ? null : `${live.agentMemoryMb} MB`,
    ].filter(Boolean);
    findings.push(
      finding(
        "footprint_high",
        rig,
        "warning",
        `${rig.name}: the rig agent is using ${usage.join(" and ")} - iRacing should not have to share that`,
        fields,
      ),
    );
  }

  return findings;
}

function lastLive(heartbeats: readonly Heartbeat[]): Heartbeat | null {
  return heartbeats.findLast((h) => !h.shuttingDown) ?? null;
}

/**
 * Rule 3a. A lap has waited past LAP_STUCK_AFTER_S, and the link demonstrably
 * worked while it waited: at least one heartbeat before this one arrived after
 * the lap was queued. Without that second heartbeat, the first heartbeat after
 * an outage would fire it for laps that are about to flush - the outage is
 * rule 1's, and the backlog drains within seconds of the link returning.
 */
function lapsStuck(heartbeats: readonly Heartbeat[], state: Heartbeat): boolean {
  if (state.pendingLaps === null || state.pendingLaps === 0) return false;
  if (state.oldestPendingAgeS === null || state.oldestPendingAgeS <= LAP_STUCK_AFTER_S) {
    return false;
  }
  // An age is a duration, so it converts onto the server's clock unskewed.
  const queuedAt = state.receivedAt - state.oldestPendingAgeS * 1000;
  return heartbeats.some(
    (h) => h !== state && h.receivedAt > queuedAt && h.receivedAt < state.receivedAt,
  );
}

/**
 * Rule 10: agent processes that started within RESTART_WINDOW_MS and lived to
 * send a heartbeat. Each process names its own start on the rig's clock; the
 * process's age at its earliest heartbeat here (sent - started, a duration on
 * that clock) places the start on the server's. The earliest, because the
 * rig's clock can be stepped while the agent runs: a process young enough to
 * count has its first heartbeat in the snapshot, sent before any such step,
 * and a clock stepped back past the start leaves a negative age that proves
 * nothing.
 */
function recentStarts(now: number, heartbeats: readonly Heartbeat[]): number {
  const earliest = new Map<number, Heartbeat>();
  for (const h of heartbeats) {
    if (h.processStartedAt !== null && !earliest.has(h.processStartedAt)) {
      earliest.set(h.processStartedAt, h);
    }
  }
  let starts = 0;
  for (const [processStartedAt, h] of earliest) {
    const age = (h.sentAt ?? h.receivedAt) - processStartedAt;
    if (age >= 0 && now - (h.receivedAt - age) <= RESTART_WINDOW_MS) starts++;
  }
  return starts;
}

function finding(
  rule: RuleKey,
  rig: RigSnapshot,
  severity: Severity,
  headline: string,
  fields: AlertDetail["fields"],
): Finding {
  return {
    rule,
    subject: rigSubject(rig.id),
    severity,
    level: 0,
    detail: { headline, where: rig.name, fields },
  };
}

/** What every rig alert shows beside its headline. */
function rigFields(now: number, rig: RigSnapshot, state: Heartbeat | null): AlertDetail["fields"] {
  return [
    {
      name: "Driver",
      value: rig.seated
        ? `${driverName(rig.seated)} (seated ${duration(now - rig.seated.startedAt)})`
        : "nobody signed in",
    },
    {
      name: "Last heard",
      value: rig.lastSeenAt === null ? "never" : `${duration(now - rig.lastSeenAt)} ago`,
    },
    { name: "Agent", value: state?.agentVersion ?? "unknown" },
  ];
}

/**
 * The seated driver as an alert names them. A driver whose name is under
 * review (or who is banned) is never named, as the public leaderboard never
 * shows them: the alert is posted to Discord and kept in monitor_alerts.
 */
function driverName(seated: NonNullable<RigSnapshot["seated"]>): string {
  return seated.driverStatus === "active" ? seated.driverName : "a driver (name under review)";
}

function laps(n: number): string {
  return n === 1 ? "1 lap" : `${n} laps`;
}

/** 42_000 → "42 s", 360_000 → "6 min", 4_500_000 → "1 h 15 min". */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
