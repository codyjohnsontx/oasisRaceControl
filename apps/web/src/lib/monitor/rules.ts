import { formatLapTime } from "@/lib/time";
import { comboMismatch } from "@/lib/validity";
import { CURRENT_AGENT_VERSION } from "./agent-version";
import { venueToday } from "@/lib/venue";
import {
  boardName,
  boardState,
  boardsToday,
  eventDisplays,
  eventMode,
  eventModeBegan,
  type BoardSnapshot,
  type EventMode,
  type EventModeOverride,
} from "./event-mode";
import { holdingSince, lastSent, rigState, type Heartbeat } from "./rig-state";

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

/**
 * `software`: a code defect is a plausible cause (the plan's "handoff" column,
 * decision D8), so an urgent alert on this rule opens a rig-alert GitHub issue
 * for the coding harness (github.ts). A rule without it opens one only when the
 * AI diagnosis classifies the cause as software - an unplugged rig must not
 * start a fix worker.
 */
export const RULES = {
  rig_silent: { number: "1", title: "Rig silent", software: false },
  venue_silent: { number: "1", title: "Every rig went quiet", software: false },
  sim_disconnected: { number: "2", title: "iRacing not connected while a driver is signed in", software: false },
  laps_stuck: { number: "3a", title: "Laps queued but not reaching the site", software: true },
  laps_refused: { number: "3b", title: "Laps refused by the site", software: true },
  no_featured_combo: { number: "4", title: "No featured car and track today", software: false },
  unattributed_laps: { number: "5a", title: "Laps with nobody signed in", software: false },
  long_stint: { number: "5b", title: "Unusually long stint", software: false },
  sign_in_failures: { number: "6", title: "Repeated sign-in failures", software: false },
  wrong_combo: { number: "7", title: "Wrong car or track", software: false },
  board_dark: { number: "8a", title: "TV board went dark", software: false },
  board_feed_failing: { number: "8b", title: "TV board cannot load its numbers", software: true },
  agent_restarting: { number: "10", title: "Rig agent restarting repeatedly", software: true },
  agent_outdated: { number: "11", title: "Outdated rig agent", software: false },
  clock_skew: { number: "12", title: "Rig clock is off", software: false },
  driver_moved: { number: "13", title: "Driver moved rigs mid-session", software: false },
  fast_lap: { number: "14", title: "Implausibly fast lap", software: false },
  telemetry_faulted: { number: "15", title: "Lap reading stopped", software: true },
  checkout_not_saved: { number: "16", title: "Sign-out not saved", software: true },
  missing_variables: { number: "17", title: "iRacing build missing variables", software: true },
  footprint_high: { number: "18", title: "Rig agent footprint high", software: true },
} as const;

export type RuleKey = keyof typeof RULES;

/** Rule 8b: a board whose loads failed this many times in a row. */
export const FEED_FAILURES_TO_ALERT = 3;
/**
 * Rule 9b. The outside clock evaluates every minute from 08:00 to midnight,
 * venue time, and every 30 minutes overnight (docs/monitoring.md), so only
 * the part of a gap inside those hours counts, and more than this of it means
 * the clock stopped.
 */
export const MONITOR_GAP_MS = 10 * 60_000;
export const VENUE_HOURS_START = 8;

/**
 * Rules whose alert closes without a "recovered" message. Rule 14 flags one
 * lap for a person to look at; the lap passing out of the monitor's view is
 * not news, and it never meant anything was broken.
 */
export const RECOVERS_SILENTLY: readonly RuleKey[] = ["fast_lap"];

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
 * closing. A seated rig never waits: someone is mid-session on it.
 */
export const CORRELATION_WINDOW_MS = 5 * 60_000;
/**
 * How far back `RigSnapshot.heard` reaches: far enough to see, for any rig
 * still inside the lookback, the venue silence it went quiet into and the
 * rigs that went quiet with it.
 */
export const HEARD_HISTORY_MS = SILENT_LOOKBACK_MS + CORRELATION_WINDOW_MS;
/**
 * How long the venue note holds once the first rig is heard again, so rigs
 * still coming back from the same outage are not warned about one by one.
 * An offline agent backs its heartbeat off to HeartbeatSchedule.MaxInterval
 * (300 s) with Jitter (10%) in apps/rig-agent/OasisRigAgent.Core/Heartbeat.cs,
 * so the last rig back can land 330 s after the first; the rest is slack for
 * the evaluation that notices it.
 */
export const VENUE_RECOVERY_GRACE_MS = 7 * 60_000;
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
/**
 * How far back, by arrival, the snapshot's laps reach: rules 5a, 7 and 14 look
 * back this far at most.
 */
export const LAP_HISTORY_MS = 15 * 60_000;
/** Rule 5a: this many laps with nobody signed in, inside the window, fire it. */
export const UNATTRIBUTED_TO_ALERT = 2;
export const UNATTRIBUTED_WINDOW_MS = 10 * 60_000;
/** And an open one clears this long after the last of them, if no attributed lap came first. */
export const UNATTRIBUTED_CLEAR_MS = 15 * 60_000;
/** Rule 6: this many refused sign-ins inside the window fire it... */
export const SIGN_IN_FAILURES_TO_ALERT = 3;
export const SIGN_IN_FAILURE_WINDOW_MS = 5 * 60_000;
/** ...and it clears after this long without one. */
export const SIGN_IN_FAILURE_CLEAR_MS = 10 * 60_000;
/** Rule 7: the rig's last this-many laps, inside the window, all on the wrong combo. */
export const COMBO_REJECTED_LAPS = 3;
export const COMBO_REJECTED_WINDOW_MS = 15 * 60_000;
/** Rule 13: how long after a driver moved rigs the rig they left is watched. */
export const MOVE_WINDOW_MS = 10 * 60_000;
/**
 * Rule 14: a valid lap under this fraction of the best any other driver has
 * on the same car and track, once at least this many other drivers have one.
 */
export const FAST_LAP_RATIO = 0.97;
export const FAST_LAP_MIN_OTHER_DRIVERS = 5;

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
  /**
   * When the rig was heard over the last HEARD_HISTORY_MS, oldest first: each
   * unbroken run of heartbeats (no gap over SILENT_AFTER_MS) from its first to
   * its last. Rule 1 reads it to tell a venue-wide silence, and who came back
   * from one, which `heartbeats` is too short to show.
   */
  heard: Array<{ from: number; to: number }>;
};

/** A car and track, in the strings laps are posted with. */
export type FeaturedCombo = { trackName: string; trackConfig: string | null; carName: string };

/** A stored lap, as rules 5a, 7 and 14 read it. */
export type LapSnapshot = {
  id: string;
  rigId: string;
  /** laps.created_at: when the site stored it, on the database's clock. */
  receivedAt: number;
  /** Who it belongs to; null for a lap stored unattributed. */
  driver: { id: string; name: string; status: string } | null;
  combo: FeaturedCombo;
  lapTimeMs: number;
  valid: boolean;
  invalidReason: string | null;
  unattributedCause: string | null;
};

export type MonitorSnapshot = {
  /** The database's now(), which every stored time is on. */
  now: number;
  /** When the current venue day began (venue-local midnight). */
  venueDayStart: number;
  rigs: RigSnapshot[];
  /** Today's featured combo (featured_combos for venue_today()), or null when none is set. */
  featuredCombo: FeaturedCombo | null;
  /** monitor_state.long_stint_minutes: rule 5b's threshold, which staff can change. */
  longStintMinutes: number;
  /** Every lap stored in the last LAP_HISTORY_MS, oldest first. */
  laps: LapSnapshot[];
  /**
   * Each driver's best valid lap stored before those, on every car and track
   * one of the recent valid laps was driven on: with the recent laps, rule
   * 14's "the best anyone else had before this lap".
   */
  lapBests: Array<{ combo: FeaturedCombo; driverId: string; lapTimeMs: number }>;
  /**
   * Stints ended by their driver signing in on another rig (end_reason
   * 'moved') in the last MOVE_WINDOW_MS, and the rig the driver is on now.
   */
  moves: Array<{
    fromRigId: string;
    toRigId: string | null;
    endedAt: number;
    driverName: string;
    driverStatus: string;
  }>;
  /** The staff event-mode override, expired or not; eventMode() judges it. */
  override: EventModeOverride | null;
  /**
   * When the channel was told event mode came on, or null while it was last
   * told off - so the evaluation that turns it on finds it began just now.
   */
  eventModeSince: number | null;
  /** The /tv pages heard from since the venue day began, or within the live window before now. */
  boards: BoardSnapshot[];
  openAlerts: ReadonlyArray<{ rule: string; subject: string }>;
};

/**
 * Whether the venue is in event mode, which raises rules 5a and 7 to urgent:
 * eventMode() in event-mode.ts, the one judgement the alerts, the 20-minute
 * update and the staff page share.
 */
export function inEventMode(snapshot: MonitorSnapshot): boolean {
  return eventMode(snapshot).on;
}

/** What an alert's messages say, fixed when the rule fired. */
export type AlertDetail = {
  /** One line: the whole alert, as a phone notification shows it. */
  headline: string;
  /** Which rig, by its staff-set display name, or "Venue". */
  where: string;
  /**
   * The rig's server-owned number (rigs.rig_number), which is how anything
   * public names the rig: the display name is free text staff typed, and
   * only the private Discord alert shows it (diagnosis/context.ts).
   */
  rigNumber?: number;
  fields: Array<{ name: string; value: string }>;
  /**
   * The seated driver's name when the text above uses it, so the AI
   * diagnosis can take it out before the prompt leaves (diagnosis/context.ts).
   * Null when nobody is seated or the name is under review, which the text
   * never shows. Every rig alert carries it; a rig alert stored without it
   * may name a driver it cannot redact, so it is never diagnosed (store.ts).
   */
  driver?: string | null;
  /**
   * The rigs a venue note speaks for, as rig subjects: the ones its headline
   * names. The data-flow view draws the note on these lanes and no others.
   */
  rigs?: string[];
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

/** Rule 11's subject: the rig, and the build it should be running. */
export function outdatedAgentSubject(rigId: string): string {
  return `${rigSubject(rigId)}|${CURRENT_AGENT_VERSION}`;
}

/** Rule 14's subject: the rig, and the lap - one alert per lap. */
export function fastLapSubject(rigId: string, lapId: string): string {
  return `${rigSubject(rigId)}|lap:${lapId}`;
}

/**
 * What flapping is counted over (store.ts, FLAPPING_REFIRES): the part of a
 * subject before its first "|". A subject that names something finer than a
 * rig - a lap (rule 14), a build (rule 11) - keeps one alert per lap or build,
 * but its openings flap together with the rest of that rig's on the same
 * rule; otherwise six implausible laps on one rig would be six histories, and
 * six posts the mute never caught.
 */
export function flapScope(subject: string): string {
  return subject.split("|", 1)[0]!;
}

type Rig = { rig: RigSnapshot; state: Heartbeat | null };

export function evaluateRules(snapshot: MonitorSnapshot): Finding[] {
  const open = new Set(snapshot.openAlerts.map((a) => `${a.rule}|${a.subject}`));
  const isOpen = (rule: RuleKey, subject: string) => open.has(`${rule}|${subject}`);
  const rigs = snapshot.rigs.map((rig) => ({ rig, state: rigState(rig.heartbeats) }));
  const mode = eventMode(snapshot);
  const eventSince = eventModeBegan(snapshot);

  return [
    ...silence(snapshot.now, rigs, eventSince, isOpen),
    ...rigs.flatMap(({ rig, state }) =>
      state ? rigFindings(snapshot.now, rig, state, isOpen, snapshot.openAlerts) : [],
    ),
    ...rigs.flatMap((r) => seatAndLapFindings(snapshot, r, mode.on, isOpen)),
    ...driverMoves(snapshot, rigs, isOpen),
    ...fastLaps(snapshot),
    ...noFeaturedCombo(snapshot, rigs, mode),
    ...boardFindings(snapshot, mode),
  ];
}

/**
 * Rule 1: rigs that stopped reaching the site without saying goodbye. In
 * event mode (`eventSince`, when it began) a rig switched on for it - heard
 * since event mode began, or since the venue came back from its last silence
 * while it has not gone silent again - is urgent at once and never part of
 * the "venue closed?" note: mid-event, rigs going quiet together is an
 * outage, not closing time. A rig that went dark with the venue - switched
 * off last night, not switched on yet - is judged as on any other day, so
 * turning event mode on never pages about a rig nobody has turned on.
 */
function silence(
  now: number,
  rigs: Rig[],
  eventSince: number | null,
  isOpen: (rule: RuleKey, subject: string) => boolean,
): Finding[] {
  const findings: Finding[] = [];
  // A rig whose standing state is its goodbye was shut down on purpose.
  const reporting = rigs.filter(
    ({ rig, state }) => rig.lastSeenAt !== null && state?.shuttingDown !== true,
  );
  const quietFor = ({ rig }: Rig) => now - rig.lastSeenAt!;
  const anyLive = reporting.some((r) => quietFor(r) <= SILENT_AFTER_MS);
  const silent = reporting.filter(
    (r) =>
      quietFor(r) > SILENT_AFTER_MS &&
      (quietFor(r) <= SILENT_LOOKBACK_MS || isOpen("rig_silent", rigSubject(r.rig.id))),
  );

  // The venue was last heard again when the first rig came back from a venue
  // silence: none heard for over SILENT_AFTER_MS, after two or more went quiet
  // together - the note's own condition, so one rig's crash is not one. Every
  // rig's runs count, including a rig that came back and is quiet again.
  const runs = reporting.map(({ rig }) => heardRuns(rig));
  const lastHeardBefore = (t: number) =>
    runs
      .map((own) => Math.max(...own.filter((run) => run.from < t).map((run) => Math.min(run.to, t))))
      .filter((at) => at > -Infinity);
  const afterVenueSilence = (t: number) => {
    const words = lastHeardBefore(t);
    const last = Math.max(...words);
    return (
      t - last > SILENT_AFTER_MS &&
      words.filter((at) => last - at <= CORRELATION_WINDOW_MS).length >= 2
    );
  };
  const heardAgainAt = Math.max(
    ...runs
      .flat()
      .map((run) => run.from)
      .filter((from) => now - from <= SILENT_LOOKBACK_MS && afterVenueSilence(from)),
  );

  // A rig whose last word came before that, and that has not been heard since,
  // went dark with the venue - closed for the night, or cut off - and is not
  // warned about on its own. So did every rig, while the venue is silent now.
  const venueBackSince = afterVenueSilence(now) ? Infinity : heardAgainAt;
  const switchedOnForEvent = ({ rig }: Rig) =>
    eventSince !== null &&
    (rig.lastSeenAt! >= eventSince || (venueBackSince > -Infinity && rig.lastSeenAt! >= venueBackSince));
  const dark: Rig[] = [];
  const unexplained: Rig[] = [];
  for (const r of silent) {
    const subject = rigSubject(r.rig.id);
    if (r.rig.seated || switchedOnForEvent(r)) {
      findings.push(rigSilent(now, r, "urgent"));
    } else if (isOpen("rig_silent", subject)) {
      findings.push(rigSilent(now, r, "warning"));
    } else if (r.rig.lastSeenAt! < heardAgainAt) {
      dark.push(r);
    } else {
      unexplained.push(r);
    }
  }

  const lastSeen = unexplained.map(({ rig }) => rig.lastSeenAt!);
  const together =
    unexplained.length >= 2 &&
    Math.max(...lastSeen) - Math.min(...lastSeen) <= CORRELATION_WINDOW_MS;
  const venueOpen = isOpen("venue_silent", VENUE_SUBJECT);
  const venueRecovering = anyLive && venueOpen && now - heardAgainAt < VENUE_RECOVERY_GRACE_MS;
  // The note speaks for rigs that went quiet together, and holds for the rest
  // until the venue is heard again; a rig heard since then is judged on its own.
  const covered =
    !anyLive && (together || (venueOpen && heardAgainAt === -Infinity)) ? unexplained : [];
  if ((!anyLive && (together || venueOpen)) || venueRecovering) {
    const quiet = [...dark, ...covered];
    const names = quiet.map(({ rig }) => rig.name);
    findings.push({
      rule: "venue_silent",
      subject: VENUE_SUBJECT,
      severity: "warning",
      level: 0,
      detail: {
        headline: `${names.length > 0 ? names.join(", ") : "Every rig"} went quiet together - venue closed?`,
        where: "Venue",
        fields: [{ name: "Rigs", value: names.join(", ") || "-" }],
        rigs: quiet.map(({ rig }) => rigSubject(rig.id)),
      },
    });
  }

  for (const r of unexplained) {
    if (!covered.includes(r) && quietFor(r) >= SILENT_AFTER_MS + CORRELATION_WINDOW_MS) {
      findings.push(rigSilent(now, r, "warning"));
    }
  }
  return findings;
}

/**
 * The rig's heard runs through its last word (`lastSeenAt`, which any request
 * moves - a rig can come back by flushing its laps before its backed-off
 * heartbeat lands, which starts a run of its own).
 */
function heardRuns(rig: RigSnapshot): Array<{ from: number; to: number }> {
  const runs = [...rig.heard];
  const last = runs.at(-1);
  const seen = rig.lastSeenAt!;
  if (last && seen - last.to <= SILENT_AFTER_MS) {
    runs[runs.length - 1] = { from: last.from, to: Math.max(last.to, seen) };
  } else if (!last || seen > last.to) {
    runs.push({ from: seen, to: seen });
  }
  return runs;
}

function rigSilent(now: number, { rig, state }: Rig, severity: Severity): Finding {
  const quiet = duration(now - rig.lastSeenAt!);
  const seated = rig.seated ? ` with ${driverName(rig.seated)} signed in` : "";
  return finding("rig_silent", rig, severity, `${rig.name} has been silent for ${quiet}${seated}`, [
    ...rigFields(now, rig, state),
  ]);
}

/**
 * A rig switched on and reporting now: its standing state is not a goodbye,
 * and it has been heard inside SILENT_AFTER_MS. Rules that must not open on a
 * rig that went dark with the venue open only while this holds.
 */
function isLive(now: number, rig: RigSnapshot, state: Heartbeat | null): state is Heartbeat {
  return state !== null && !state.shuttingDown && rig.lastSeenAt !== null && now - rig.lastSeenAt <= SILENT_AFTER_MS;
}

function rigFindings(
  now: number,
  rig: RigSnapshot,
  state: Heartbeat,
  isOpen: (rule: RuleKey, subject: string) => boolean,
  openAlerts: MonitorSnapshot["openAlerts"],
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

  // Rule 6 holds through a goodbye: the refusals happened, and a goodbye can
  // be the heartbeat that reports them.
  const refused = signInFailures(now, rig.heartbeats, isOpen("sign_in_failures", subject));
  if (refused) {
    findings.push(
      finding(
        "sign_in_failures",
        rig,
        "warning",
        `${rig.name}: ${refused.count} walk-up sign-ins refused in ${duration(refused.window)} ` +
          `(${refused.kinds.join(", ")})`,
        [...fields, { name: "Sign-in failures", value: String(refused.count) }],
      ),
    );
  }

  // Rule 11: the agent build, once per rig per version - the subject names
  // CURRENT_AGENT_VERSION, so a new release opens a fresh alert naming it.
  // It opens only on a rig that is live: one that went dark with the venue
  // stays quiet until it is switched on again. While the rig still runs an
  // outdated build, every alert open on it holds - one naming an earlier
  // release too, so a release made after closing posts nothing, and nothing
  // reads as recovered until the rig reports the current build.
  const version = state.agentVersion;
  if (version !== null && version !== CURRENT_AGENT_VERSION) {
    const subjects = new Set(
      openAlerts
        .filter((alert) => alert.rule === "agent_outdated" && alert.subject.startsWith(`${subject}|`))
        .map((alert) => alert.subject),
    );
    if (isLive(now, rig, state)) subjects.add(outdatedAgentSubject(rig.id));
    for (const outdated of subjects) {
      findings.push({
        ...finding(
          "agent_outdated",
          rig,
          "warning",
          `${rig.name} runs an outdated rig agent - install ${CURRENT_AGENT_VERSION} on it`,
          [...fields, { name: "Current build", value: CURRENT_AGENT_VERSION }],
        ),
        subject: outdated,
      });
    }
  }

  // Rules 12, 17 and 18 describe the rig, not the process, so a restart does
  // not end them. They are judged on the rig's last live heartbeat; while the
  // standing state is a goodbye they only hold an alert already open, and the
  // goodbye neither opens nor clears one.
  const live = state.shuttingDown ? lastSent(rig.heartbeats, (h) => !h.shuttingDown) : state;
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

  // The agent learns what iRacing publishes only while attached, and forgets
  // it whenever iRacing goes, so only an attached heartbeat is evidence; with
  // none in view an open alert holds.
  const attached = lastSent(rig.heartbeats, (h) => !h.shuttingDown && h.simConnected === true);
  const missing = attached?.missingVariables ?? [];
  if (attached ? missing.length > 0 : isOpen("missing_variables", subject)) {
    findings.push(
      finding(
        "missing_variables",
        rig,
        "warning",
        `${rig.name}: this iRacing build does not publish ${missing.length > 0 ? missing.join(", ") : "some variables the agent reads"}`,
        fields,
      ),
    );
  }

  const cpuSince = holdingSince(
    rig.heartbeats,
    live,
    (h) => h.agentCpuPercent !== null && h.agentCpuPercent > FOOTPRINT_CPU_PERCENT,
  );
  // Once open, CPU over the line holds it without a fresh five-minute run.
  const cpuHigh =
    cpuSince !== null &&
    (isOpen("footprint_high", subject) || live.receivedAt - cpuSince >= FOOTPRINT_CPU_FOR_MS);
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

const SIGN_IN_FAILURE_WORDS: Record<string, string> = {
  wrong_pin_or_name: "wrong PIN or name",
  locked: "locked out",
  rate_limited: "too many tries",
  unreachable: "site unreachable",
  other: "refused for another reason",
};

/**
 * Rule 6: walk-up sign-ins the rig reported refused, SIGN_IN_FAILURES_TO_ALERT
 * of them inside SIGN_IN_FAILURE_WINDOW_MS; an open alert holds while any
 * arrived inside SIGN_IN_FAILURE_CLEAR_MS. A heartbeat reports every refusal
 * the site has not acknowledged, so after an answer is lost the next one
 * reports the same refusals again under a new heartbeat sequence. So only a
 * report that carries `signInFailureSeqs` (rig-agent/0.5-monitor and later)
 * is counted, by those: each refusal once per agent process, when it first
 * arrived. One without them - an older agent, or no process start to key on -
 * is stored but not counted here, since its replayed counts cannot be told
 * from new refusals; rule 11 asks for the upgrade that brings it into rule 6.
 */
function signInFailures(
  now: number,
  heartbeats: readonly Heartbeat[],
  open: boolean,
): { count: number; window: number; kinds: string[] } | null {
  const seen = new Set<string>();
  const reports = heartbeats.flatMap((h) => {
    if (h.signInFailureSeqs === null || h.processStartedAt === null) return [];
    const fresh = h.signInFailureSeqs.filter((seq) => {
      const key = `${h.processStartedAt}|${seq}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return fresh.length > 0 ? [{ h, count: fresh.length }] : [];
  });
  const within = (window: number) => {
    const inside = reports.filter(({ h }) => now - h.receivedAt <= window);
    const kinds = new Set(inside.flatMap(({ h }) => h.signInFailureKinds));
    return {
      count: inside.reduce((sum, { count }) => sum + count, 0),
      window,
      kinds: Object.keys(SIGN_IN_FAILURE_WORDS)
        .filter((kind) => kinds.has(kind))
        .map((kind) => SIGN_IN_FAILURE_WORDS[kind]!),
    };
  };
  const recent = within(SIGN_IN_FAILURE_WINDOW_MS);
  if (recent.count >= SIGN_IN_FAILURES_TO_ALERT) return recent;
  if (!open) return null;
  const holding = within(SIGN_IN_FAILURE_CLEAR_MS);
  return holding.count > 0 ? holding : null;
}

const COMBO_REASONS = new Set(["WRONG_TRACK_CONFIGURATION", "WRONG_CAR"]);

function wrongPart(reason: string): string {
  return reason === "WRONG_CAR" ? "car" : "track or layout";
}

export function comboLabel(combo: FeaturedCombo): string {
  return [[combo.trackName, combo.trackConfig].filter(Boolean).join(" "), combo.carName].join(" · ");
}

/**
 * Rules judged from a rig's seat and its stored laps rather than from its
 * heartbeats, so they hold for an agent too old to send more than its
 * version: 5a, 5b and the laps half of 7. Rule 7's session half reads the
 * rig's live heartbeat.
 */
function seatAndLapFindings(
  snapshot: MonitorSnapshot,
  { rig, state }: Rig,
  eventMode: boolean,
  isOpen: (rule: RuleKey, subject: string) => boolean,
): Finding[] {
  const { now } = snapshot;
  const findings: Finding[] = [];
  const subject = rigSubject(rig.id);
  const fields = rigFields(now, rig, state);
  const rigLaps = snapshot.laps.filter((lap) => lap.rigId === rig.id);
  const raised: Severity = eventMode ? "urgent" : "warning";
  const live = isLive(now, rig, state) ? state : null;

  // Rule 5a: laps the agent said nobody was signed in for, since the rig's
  // last lap that did reach a driver.
  const lastOwned = Math.max(...rigLaps.filter((lap) => lap.driver !== null).map((lap) => lap.receivedAt));
  const unowned = rigLaps.filter(
    (lap) => lap.unattributedCause === "nobody_checked_in" && lap.receivedAt > lastOwned,
  );
  const inside = (window: number) => unowned.filter((lap) => now - lap.receivedAt <= window);
  const firing = inside(UNATTRIBUTED_WINDOW_MS);
  const window =
    firing.length >= UNATTRIBUTED_TO_ALERT
      ? UNATTRIBUTED_WINDOW_MS
      : isOpen("unattributed_laps", subject) && inside(UNATTRIBUTED_CLEAR_MS).length > 0
        ? UNATTRIBUTED_CLEAR_MS
        : null;
  if (window !== null) {
    const n = inside(window).length;
    findings.push(
      finding(
        "unattributed_laps",
        rig,
        raised,
        `${rig.name}: ${laps(n)} in the last ${duration(window)} landed with nobody signed in - ` +
          "they will not rank; laps rank again once someone signs in on the rig",
        [...fields, { name: "Laps with nobody signed in", value: String(n) }],
      ),
    );
  }

  // Rule 5b: a stint far longer than a session runs - usually a driver who
  // walked away without signing out, whose name the next laps would carry. It
  // opens only on a live rig, so a stint left open at closing stays quiet
  // until the rig is switched on again; an alert already open holds.
  if (rig.seated) {
    const seatedFor = now - rig.seated.startedAt;
    if (seatedFor > snapshot.longStintMinutes * 60_000 && (live || isOpen("long_stint", subject))) {
      findings.push(
        finding(
          "long_stint",
          rig,
          "warning",
          `${rig.name}: ${driverName(rig.seated)} has been signed in for ${duration(seatedFor)} - ` +
            "still driving, or a missed sign-out?",
          fields,
        ),
      );
    }
  }

  // Rule 7: the rig is racing something other than today's featured combo -
  // its live session while a driver is seated, or its last few laps - judged
  // by the same comparison ingestion uses, so it never disagrees with which
  // laps are refused. Without a combo nothing is wrong (rule 4's business).
  //
  // Each input is a signal at the moment it was heard, and the newest
  // definitive one decides: a wrong live session while a driver is seated, the
  // last right session the rig reported (live, seated or not), a run of
  // COMBO_REJECTED_LAPS combo-refused laps at the last of them, a valid lap at
  // its arrival. So fixing the car clears the alert at the next heartbeat even
  // with the refused laps still in view - and it stays clear once the seat
  // empties or the sim closes - a valid lap clears it even before the next
  // heartbeat, and a wrong session heard after either opens it again. On a tie
  // the wrong signal wins. Like 5b it opens only on a live rig: a right
  // session is judged against today's combo, so a combo change would let a
  // switched-off rig's refused laps decide again; an alert already open holds.
  const combo = snapshot.featuredCombo;
  if (combo) {
    type Signal = { at: number; wrong: string | null; from: "session" | "laps" };
    const signals: Signal[] = [];
    const mismatch = (session: NonNullable<Heartbeat["session"]>) =>
      comboMismatch({ track_name: combo.trackName, track_config: combo.trackConfig, car_name: combo.carName }, session);
    const wrongSession = rig.seated && live?.simConnected === true && live.session ? mismatch(live.session) : null;
    // The rig's current state (rigState, by send order) is the session signal
    // when it is a judged wrong one: an earlier right-combo heartbeat that
    // merely arrived later must not outvote it. Only without one does the last
    // right session count, which is what keeps a cleared alert clear once the
    // seat empties, the sim closes or the rig goes quiet.
    if (wrongSession) {
      signals.push({ at: live!.receivedAt, from: "session", wrong: wrongSession });
    } else {
      const right = lastSent(rig.heartbeats, (h) => h.simConnected === true && h.session !== null && !mismatch(h.session));
      if (right) signals.push({ at: right.receivedAt, from: "session", wrong: null });
    }
    const recent = rigLaps.filter((lap) => now - lap.receivedAt <= COMBO_REJECTED_WINDOW_MS);
    const last = recent.slice(-COMBO_REJECTED_LAPS);
    if (last.length === COMBO_REJECTED_LAPS && last.every((lap) => COMBO_REASONS.has(lap.invalidReason ?? ""))) {
      signals.push({ at: last.at(-1)!.receivedAt, from: "laps", wrong: last.at(-1)!.invalidReason! });
    }
    const valid = recent.findLast((lap) => lap.valid);
    if (valid) signals.push({ at: valid.receivedAt, from: "laps", wrong: null });

    const decides = signals.reduce<Signal | null>(
      (newest, signal) =>
        !newest || signal.at > newest.at || (signal.at === newest.at && signal.wrong !== null) ? signal : newest,
      null,
    );
    const rejected = recent.filter((lap) => COMBO_REASONS.has(lap.invalidReason ?? "")).length;
    if (decides?.wrong && (live || isOpen("wrong_combo", subject))) {
      const headline =
        decides.from === "session"
          ? `${rig.name} is in an iRacing session on the wrong ${wrongPart(decides.wrong)} for today's ` +
            `featured combo while ${driverName(rig.seated!)} is signed in - their laps will not rank`
          : `${rig.name}: its last ${COMBO_REJECTED_LAPS} laps were on the wrong ${wrongPart(decides.wrong)} ` +
            "for today's featured combo, so none of them rank";
      findings.push(
        finding("wrong_combo", rig, raised, headline, [
          ...fields,
          { name: "Today's combo", value: comboLabel(combo) },
          { name: "Combo-rejected laps", value: String(rejected) },
        ]),
      );
    }
  }

  return findings;
}

/**
 * Rule 13, the plan's "same driver on two rigs". The literal case cannot
 * happen: one_open_assignment_per_driver (db/migrations/0001_core_schema.sql)
 * lets a driver hold one stint at a time, and signing in on a second rig ends
 * the first with end_reason 'moved' (checkin_driver). What does happen is the
 * move itself while the rig left behind is still racing: whoever is driving
 * it now is signed in as nobody, or is the driver who moved and forgot. So a
 * move fires while, within MOVE_WINDOW_MS of it, the rig left behind has
 * nobody signed in and its agent - heard since the move - is still in an
 * iRacing session. It holds for the window, since the rig leaving the session
 * does not say whose laps it was driving.
 */
function driverMoves(
  snapshot: MonitorSnapshot,
  rigs: Rig[],
  isOpen: (rule: RuleKey, subject: string) => boolean,
): Finding[] {
  const { now } = snapshot;
  const latest = new Map<string, MonitorSnapshot["moves"][number]>();
  for (const move of snapshot.moves) {
    if (now - move.endedAt > MOVE_WINDOW_MS) continue;
    const other = latest.get(move.fromRigId);
    if (!other || move.endedAt > other.endedAt) latest.set(move.fromRigId, move);
  }

  const findings: Finding[] = [];
  for (const [rigId, move] of latest) {
    const from = rigs.find(({ rig }) => rig.id === rigId);
    if (!from || from.rig.seated) continue;
    const { rig, state } = from;
    const subject = rigSubject(rig.id);
    const stillRacing =
      state !== null &&
      !state.shuttingDown &&
      state.receivedAt > move.endedAt &&
      state.simConnected === true &&
      state.session !== null;
    if (!stillRacing && !isOpen("driver_moved", subject)) continue;

    const name = nameOf(move.driverName, move.driverStatus);
    const to = rigs.find(({ rig: other }) => other.id === move.toRigId)?.rig.name ?? "another rig";
    findings.push({
      rule: "driver_moved",
      subject,
      severity: "warning",
      level: 0,
      detail: {
        headline:
          `${name} signed in on ${to} while still seated on ${rig.name}, which is still in an ` +
          "iRacing session - is someone driving it without signing in?",
        where: rig.name,
        fields: [
          ...rigFields(now, rig, state),
          { name: "Moved", value: `${duration(now - move.endedAt)} ago` },
        ],
        driver: move.driverStatus === "active" ? move.driverName : null,
      },
    });
  }
  return findings;
}

function comboKey(combo: FeaturedCombo): string {
  return [combo.trackName, combo.trackConfig ?? "", combo.carName].join("\u0000");
}

/**
 * Rule 14: a valid lap well under the best any other driver had driven on the
 * same car and track before it, once enough other drivers have driven it for
 * that best to mean something. It only flags the lap for staff to look at -
 * it never touches laps.is_valid, since validity is decided once, at
 * ingestion (AGENTS.md). Each lap is its own subject (fastLapSubject), so a
 * lap fires once, and its alert closes quietly (RECOVERS_SILENTLY) once the
 * lap has passed out of the snapshot; the laps of one rig flap together
 * (flapScope), so a run of them is muted like any other flapping rule, and
 * every lap of the mute is listed in one summary when it ends (store.ts,
 * claimFastLapSummaries). "Before it" keeps the verdict on a lap from changing
 * when a later lap is driven, and makes the second of two implausible laps
 * look plausible only against the first - both are drivers' laps someone
 * should look at, and the first is already flagged.
 */
function fastLaps(snapshot: MonitorSnapshot): Finding[] {
  const findings: Finding[] = [];
  for (const lap of snapshot.laps) {
    if (!lap.valid || !lap.driver) continue;
    const driverId = lap.driver.id;
    const key = comboKey(lap.combo);
    const bests = new Map<string, number>();
    const consider = (other: string, ms: number) => {
      if (other !== driverId) bests.set(other, Math.min(bests.get(other) ?? Infinity, ms));
    };
    for (const best of snapshot.lapBests) {
      if (comboKey(best.combo) === key) consider(best.driverId, best.lapTimeMs);
    }
    for (const earlier of snapshot.laps) {
      if (earlier.valid && earlier.driver && earlier.receivedAt < lap.receivedAt && comboKey(earlier.combo) === key) {
        consider(earlier.driver.id, earlier.lapTimeMs);
      }
    }
    if (bests.size < FAST_LAP_MIN_OTHER_DRIVERS) continue;
    const best = Math.min(...bests.values());
    if (lap.lapTimeMs >= best * FAST_LAP_RATIO) continue;

    const where = snapshot.rigs.find((rig) => rig.id === lap.rigId)?.name ?? "A rig";
    const name = nameOf(lap.driver.name, lap.driver.status);
    const under = Math.floor((1 - lap.lapTimeMs / best) * 100);
    findings.push({
      rule: "fast_lap",
      subject: fastLapSubject(lap.rigId, lap.id),
      severity: "warning",
      level: 0,
      detail: {
        headline:
          `${where}: a ${formatLapTime(lap.lapTimeMs)} lap by ${name} is ${under}% under the best any ` +
          `other driver had on this car and track (${formatLapTime(best)}) - worth a look; it ranks ` +
          "unless staff invalidate it",
        where,
        fields: [
          { name: "Driver", value: name },
          { name: "Lap time", value: formatLapTime(lap.lapTimeMs) },
          { name: "Best by another driver", value: formatLapTime(best) },
          { name: "Other drivers on this combo", value: String(bests.size) },
        ],
        driver: lap.driver.status === "active" ? lap.driver.name : null,
      },
    });
  }
  return findings;
}

/**
 * Rule 4: no featured combo for today once racing has started - in event
 * mode, or as soon as any rig is in an iRacing session. Without the row,
 * every car and track ranks on one board and any incident invalidates a lap,
 * which is what day 2 of the 2026-09-27 event ran on until 1 PM. Subject is
 * the venue, and the rule reads venue_today() each time, so a new day with no
 * row keeps the alert open and a row for today clears it.
 */
function noFeaturedCombo(snapshot: MonitorSnapshot, rigs: Rig[], mode: EventMode): Finding[] {
  if (snapshot.featuredCombo) return [];
  const { now } = snapshot;
  const inSession = rigs.filter(
    ({ rig, state }) =>
      state !== null &&
      !state.shuttingDown &&
      state.simConnected === true &&
      state.session !== null &&
      rig.lastSeenAt !== null &&
      now - rig.lastSeenAt <= SILENT_AFTER_MS,
  );
  if (!mode.on && inSession.length === 0) return [];

  const first = inSession[0];
  const why = mode.on ? "event mode is on" : `${first!.rig.name} is in an iRacing session`;
  const fields: AlertDetail["fields"] = [{ name: "Venue date", value: venueToday(new Date(now)) }];
  if (first) {
    const { session } = first.state!;
    fields.push(
      {
        name: `Session on ${first.rig.name}`,
        value: [session!.trackName, session!.trackConfig, session!.carName].filter(Boolean).join(" · "),
      },
      { name: "Set it (Neon SQL Editor)", value: "```sql\n" + featuredComboSql(session!) + "\n```" },
    );
  } else {
    fields.push({
      name: "Set it",
      value:
        "Run `OasisRigAgent.exe --diagnose` on a rig in the event's session: it prints the " +
        "featured_combos SQL to paste, with the names exactly as iRacing posts them.",
    });
  }
  return [
    {
      rule: "no_featured_combo",
      subject: VENUE_SUBJECT,
      severity: "urgent",
      level: 0,
      detail: {
        headline:
          `No featured car and track is set for today, and ${why} - every combo ranks ` +
          `together and any incident voids a lap`,
        where: "Venue",
        fields,
      },
    },
  ];
}

/**
 * The row rule 4 asks for, from a rig's own session strings - never typed from
 * memory, because the combo matches lap strings exactly (AGENTS.md).
 * `do nothing` on conflict: if someone set the day's combo meanwhile, theirs
 * stands.
 */
export function featuredComboSql(session: FeaturedCombo): string {
  const literal = (value: string | null) => (value === null ? "null" : `'${value.replaceAll("'", "''")}'`);
  return (
    "insert into featured_combos (combo_date, track_name, track_config, car_name)\n" +
    `values (venue_today(), ${literal(session.trackName)}, ${literal(session.trackConfig)}, ` +
    `${literal(session.carName)})\n` +
    "on conflict (combo_date) do nothing;"
  );
}

export function boardSubject(mode: BoardSnapshot["mode"]): string {
  return `board:${mode}`;
}

/**
 * Rules 8a and 8b, about the screen the room watches rather than a rig.
 *
 * 8a: of the event's displays (eventDisplays: today's event boards, each
 * opened from a staff link, or the shop wall while staff have forced event
 * mode on without one still open), the one heard from most recently went
 * dark: not heard from for BOARD_DARK_AFTER_MS, without a goodbye. The most
 * recent, so a browser killed and restored as a new page, or a tab closed
 * after a phone was left locked on the board, is judged by the board the room
 * is watching. An event
 * board is judged whether or not event mode is on, since a dark board no
 * longer holds it, and it is urgent: the board it reports was holding the
 * event. Staff forcing event mode off silences it. The shop wall switched off
 * at closing on an ordinary day is not news, and is not judged.
 *
 * 8b, in any mode: a live board says its last FEED_FAILURES_TO_ALERT loads
 * failed. It reached the site to say so, so the site is up and the feed is
 * what is broken.
 */
function boardFindings(snapshot: MonitorSnapshot, mode: EventMode): Finding[] {
  const { now } = snapshot;
  const findings: Finding[] = [];

  const forcedOff = mode.cause === "override" && !mode.on;
  if (!forcedOff) {
    const board = eventDisplays(snapshot).sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
    if (board && boardState(board, now) === "dark") {
      findings.push({
        rule: "board_dark",
        subject: boardSubject(board.mode),
        severity: "urgent",
        level: 0,
        detail: {
          headline:
            `${boardName(board)} has not been heard from for ${duration(now - board.lastSeenAt)} - ` +
            "laptop asleep, browser closed, or offline?",
          where: boardName(board),
          fields: [
            { name: "Last heard", value: `${duration(now - board.lastSeenAt)} ago` },
            { name: "Open since", value: `${duration(now - board.firstSeenAt)} ago` },
          ],
        },
      });
    }
  }

  for (const kind of ["event", "rotation"] as const) {
    const failing = boardsToday(snapshot)
      .filter(
        (b) =>
          b.mode === kind &&
          boardState(b, now) === "live" &&
          b.feedFailures >= FEED_FAILURES_TO_ALERT,
      )
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
    if (!failing) continue;
    findings.push({
      rule: "board_feed_failing",
      subject: boardSubject(kind),
      severity: "urgent",
      level: 0,
      detail: {
        headline:
          `${boardName(failing)}: its last ${failing.feedFailures} loads of the leaderboard failed, ` +
          `so it shows "Reconnecting" - the site answers, the feed does not`,
        where: boardName(failing),
        fields: [
          { name: "Failed loads in a row", value: String(failing.feedFailures) },
          { name: "Last heard", value: `${duration(now - failing.lastSeenAt)} ago` },
        ],
      },
    });
  }

  return findings;
}

const venueHour = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hour: "numeric",
  hourCycle: "h23",
});

function inVenueHours(at: number): boolean {
  const hour = Number(venueHour.formatToParts(at).find((p) => p.type === "hour")!.value);
  return hour >= VENUE_HOURS_START;
}

/**
 * Rule 9b: the gap since the previous evaluation, when more than
 * MONITOR_GAP_MS of it fell inside venue hours - the outside clock is not
 * ticking (or the site was down; UptimeRobot says which). A one-shot note,
 * not an alert: there is nothing to recover from once evaluations run again,
 * and only the evaluation that claimed the next turn sees the gap.
 *
 * Walks the gap a minute at a time and stops as soon as the answer is known,
 * so even a gap of days costs one night's worth of steps.
 */
export function monitorGap(previous: number | null, now: number): { from: number; to: number } | null {
  if (previous === null || now - previous <= MONITOR_GAP_MS) return null;
  const STEP = 60_000;
  let inside = 0;
  for (let at = previous; at < now; at += STEP) {
    if (inVenueHours(at)) inside += Math.min(STEP, now - at);
    if (inside > MONITOR_GAP_MS) return { from: previous, to: now };
  }
  return null;
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
    detail: {
      headline,
      where: rig.name,
      rigNumber: rig.number,
      fields,
      driver: rig.seated?.driverStatus === "active" ? rig.seated.driverName : null,
    },
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
export function driverName(seated: NonNullable<RigSnapshot["seated"]>): string {
  return nameOf(seated.driverName, seated.driverStatus);
}

export function nameOf(name: string, status: string): string {
  return status === "active" ? name : "a driver (name under review)";
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
