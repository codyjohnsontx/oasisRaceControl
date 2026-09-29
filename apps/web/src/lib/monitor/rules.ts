import { venueToday } from "@/lib/venue";
import {
  boardName,
  boardState,
  boardsToday,
  eventDisplays,
  eventMode,
  type BoardSnapshot,
  type EventMode,
  type EventModeOverride,
} from "./event-mode";
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
  no_featured_combo: { number: "4", title: "No featured car and track today" },
  board_dark: { number: "8a", title: "TV board went dark" },
  board_feed_failing: { number: "8b", title: "TV board cannot load its numbers" },
  agent_restarting: { number: "10", title: "Rig agent restarting repeatedly" },
  clock_skew: { number: "12", title: "Rig clock is off" },
  telemetry_faulted: { number: "15", title: "Lap reading stopped" },
  checkout_not_saved: { number: "16", title: "Sign-out not saved" },
  missing_variables: { number: "17", title: "iRacing build missing variables" },
  footprint_high: { number: "18", title: "Rig agent footprint high" },
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

export type FeaturedCombo = { trackName: string; trackConfig: string | null; carName: string };

export type MonitorSnapshot = {
  /** The database's now(), which every stored time is on. */
  now: number;
  /** When the current venue day began (venue-local midnight). */
  venueDayStart: number;
  rigs: RigSnapshot[];
  /** Today's featured combo, or null when none is set. */
  featuredCombo: FeaturedCombo | null;
  /** The staff event-mode override, expired or not; eventMode() judges it. */
  override: EventModeOverride | null;
  /** The /tv pages heard from since the venue day began. */
  boards: BoardSnapshot[];
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
  const mode = eventMode(snapshot);

  return [
    ...silence(snapshot.now, rigs, mode.on, isOpen),
    ...rigs.flatMap(({ rig, state }) =>
      state ? rigFindings(snapshot.now, rig, state, isOpen) : [],
    ),
    ...noFeaturedCombo(snapshot, rigs, mode),
    ...boardFindings(snapshot, mode),
  ];
}

/**
 * Rule 1: rigs that stopped reaching the site without saying goodbye. In
 * event mode every silent rig is urgent at once and there is no "venue
 * closed?" note: mid-event, rigs going quiet together is an outage, not
 * closing time.
 */
function silence(
  now: number,
  rigs: Rig[],
  eventModeOn: boolean,
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
    if (r.rig.seated || eventModeOn) {
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
  const firstHeardAgain = Math.min(...live.map(({ rig }) => heardSince(rig)));
  const venueRecovering = anyLive && venueOpen && now - firstHeardAgain < VENUE_RECOVERY_GRACE_MS;
  if (!eventModeOn && ((!anyLive && (together || venueOpen)) || venueRecovering)) {
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
 * When the rig was first heard in the unbroken run that ends at its last word
 * (`lastSeenAt`, which any request moves - a rig can come back by flushing its
 * laps before its backed-off heartbeat lands): after the last gap long enough
 * to be silence, or at its earliest heartbeat here.
 */
function heardSince(rig: RigSnapshot): number {
  let since = rig.lastSeenAt!;
  for (let i = rig.heartbeats.length - 1; i >= 0; i--) {
    const receivedAt = rig.heartbeats[i]!.receivedAt;
    if (since - receivedAt > SILENT_AFTER_MS) break;
    since = Math.min(since, receivedAt);
  }
  return since;
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

  // The agent learns what iRacing publishes only while attached, and forgets
  // it whenever iRacing goes, so only an attached heartbeat is evidence; with
  // none in view an open alert holds.
  const attached = rig.heartbeats.findLast((h) => !h.shuttingDown && h.simConnected === true);
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
 * 8a, only in event mode: the event's display (eventDisplays) went dark - not
 * heard from for BOARD_DARK_AFTER_MS without a goodbye - and no other board of
 * the same kind is live, so a browser that was killed and restored as a new
 * page is not reported. Only boards heard from today count. Outside event mode
 * the shop wall being switched off at closing is not news.
 *
 * 8b, in any mode: a live board says its last FEED_FAILURES_TO_ALERT loads
 * failed. It reached the site to say so, so the site is up and the feed is
 * what is broken.
 */
function boardFindings(snapshot: MonitorSnapshot, mode: EventMode): Finding[] {
  const { now } = snapshot;
  const findings: Finding[] = [];

  if (mode.on) {
    const displays = eventDisplays(snapshot);
    const dark = displays
      .filter((b) => boardState(b, now) === "dark")
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    const live = displays.some((b) => boardState(b, now) === "live");
    const board = dark[0];
    if (board && !live) {
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
export function driverName(seated: NonNullable<RigSnapshot["seated"]>): string {
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
