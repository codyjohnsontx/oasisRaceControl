import { createHash } from "node:crypto";
import { SIGN_IN_FAILURE_KINDS } from "@/lib/events";
import { RULES, type AlertDetail, type Severity } from "../rules";

/**
 * What an urgent alert's AI diagnosis and copy-paste handoff are written from
 * (plan decision D9). The owner chose Gemini's free tier on the premise that
 * the prompt carries no customer data, and that tier's prompts may be used by
 * Google; the handoff is pasted into a coding harness and, later, a GitHub
 * issue on a public repository. So nothing a rig typed goes in.
 *
 * That is an allowlist of kinds, not a filter of content: a heartbeat's
 * strings (session names, agent notices, variable names) are whatever a rig -
 * or anyone holding its token - sent, and no pattern can promise they hold no
 * name, address, path or instruction. What is kept is what the server can
 * vouch for:
 *
 * - numbers, booleans and values of the wire contract's own enums;
 * - the agent version, only when it has a version's shape;
 * - agent notices, only as codes of the notices the agent is known to raise
 *   (`NOTICE_CODES`), counted, each with a fixed summary written here;
 * - the alert's own words: the rule, and the headline and numeric fields the
 *   rules wrote from those numbers. The rig is named by its server-owned
 *   number ("Rig 7"), never its display name: that is free text staff typed,
 *   which could hold an instruction or a person's name, so it is replaced in
 *   the headline and a headline it would survive in is swapped for a fixed
 *   one. The seated driver's name becomes `driver-<4 hex>`; the Driver and
 *   Agent fields are dropped, since the first is that name again and the
 *   second is a rig string.
 *
 * Every string is also flattened to one line, so nothing here can pose as a
 * line of the handoff frame.
 */

export type HeartbeatRow = {
  receivedAt: number;
  clockSkewMs: number | null;
  payload: Record<string, unknown>;
};

export type AlertForDiagnosis = {
  id: string;
  rule: string;
  severity: Severity;
  openedAt: number;
  detail: AlertDetail;
};

export type HeartbeatFacts = {
  receivedAt: number;
  clockSkewMs: number | null;
  agentVersion?: string;
  processStartedAt?: number;
  sequence?: number;
  startCount?: number;
  osUptimeS?: number;
  telemetryMode?: string;
  simConnected?: boolean;
  telemetryFaulted?: boolean;
  missingVariableCount?: number;
  inSession?: boolean;
  assignmentKnown?: boolean;
  driverSeated?: boolean;
  pendingLaps?: number;
  oldestPendingAgeS?: number | null;
  rejectedLaps?: number;
  checkout?: string;
  lastLapCapturedAt?: number | null;
  lastLapPostedAt?: number | null;
  signInFailures?: number;
  signInFailureKinds?: string[];
  agentCpuPercent?: number;
  agentMemoryMb?: number;
  shuttingDown?: boolean;
};

export type IncidentContext = {
  alertId: string;
  rule: { key: string; number: string; title: string };
  severity: Severity;
  openedAt: number;
  where: string;
  headline: string;
  fields: Array<{ name: string; value: string }>;
  /** Oldest first; at most RECENT_HEARTBEATS. */
  heartbeats: HeartbeatFacts[];
  /** Agent notices in the heartbeats read, by code, with how many of each. */
  notices: Array<{ code: NoticeCode; summary: string; count: number }>;
  /** The deployed commit (VERCEL_GIT_COMMIT_SHA), or null off Vercel. */
  commit: string | null;
};

/** The heartbeats a prompt shows in full. */
export const RECENT_HEARTBEATS = 5;

/**
 * The notices apps/rig-agent/OasisRigAgent.Core/AgentService.cs raises, by the
 * fixed text each starts with. Only the code and the summary here go on; the
 * rest of a notice (an exception message, a path, an id) never does. A notice
 * the agent gains later reads as `other` until it is added here.
 */
export const NOTICE_CODES = {
  tick_failed: { prefix: "[agent] tick failed", summary: "the agent's work loop threw an error" },
  lap_queue_failed: { prefix: "[agent] failed to queue lap", summary: "a lap could not be written to the outbox" },
  telemetry_stopped: { prefix: "[telemetry] lap reading stopped", summary: "the iRacing reader faulted" },
  start_log_failed: { prefix: "[agent] failed to record this start", summary: "the agent could not log its own start" },
  checkout_queue_failed: {
    prefix: "[agent] failed to record queued sign-out",
    summary: "a sign-out could not be saved to the outbox",
  },
  checkout_forget_failed: {
    prefix: "[agent] failed to forget delivered sign-out",
    summary: "a delivered sign-out could not be cleared from the outbox",
  },
  lap_refused: {
    prefix: "[agent] the backend will not accept lap",
    summary: "the site refused a lap, which is now parked on the rig",
  },
  heartbeat_refused: {
    prefix: "[agent] the backend refused this rig's status report",
    summary: "the site refused the full heartbeat and got the bare one",
  },
  other: { prefix: null, summary: "a notice this monitor does not recognise" },
} as const;

export type NoticeCode = keyof typeof NOTICE_CODES;

/** The alert fields that are numbers the rules computed, never a rig's words. */
const NUMERIC_FIELDS = new Set([
  "Last heard",
  "Queued laps",
  "Parked laps",
  "Starts",
  "Clock skew",
  "Laps with nobody signed in",
  "Combo-rejected laps",
]);

const TELEMETRY_MODES = ["iracing", "simulated", "none"];
const CHECKOUTS = ["none", "queued", "not_queued"];
const SIGN_IN_KINDS: readonly string[] = SIGN_IN_FAILURE_KINDS;
/** rig-agent/0.4-monitor, 1.4.1: a version, and too short to hide a sentence in. */
const VERSION = /^(rig-agent\/)?\d{1,4}(\.\d{1,4}){0,3}(-[a-z0-9]{1,12})?$/i;

/** A stable stand-in for a driver's name: the same name, the same stand-in. */
export function pseudonym(name: string): string {
  return `driver-${createHash("sha256").update(name).digest("hex").slice(0, 4)}`;
}

/**
 * `heartbeats` is the rig's recent history, newest first as the store reads
 * it; an alert that is not about one rig (the venue note) has none.
 */
export function incidentContext(
  alert: AlertForDiagnosis,
  heartbeats: readonly HeartbeatRow[],
  commit: string | null,
): IncidentContext {
  const rule = RULES[alert.rule as keyof typeof RULES] ?? { number: "?", title: alert.rule };
  const oldestFirst = [...heartbeats].reverse();
  const where = publicRig(alert.detail);
  const driver = alert.detail.driver ? oneLine(alert.detail.driver) : "";
  const seated: StandIn[] = driver ? [[driver, pseudonym(driver)]] : [];
  const text = serverText(seated);

  return {
    alertId: alert.id,
    // The rule's key and title are the monitor's own words, never a driver's:
    // the key names the issue's marker, lock and re-fire lookup, which must
    // agree whatever name the seated driver chose.
    rule: { key: alert.rule, number: rule.number, title: oneLine(rule.title) },
    severity: alert.severity,
    openedAt: alert.openedAt,
    where,
    headline: publicHeadline(alert.detail.headline, alert.detail.where, seated, where, rule.title),
    fields: alert.detail.fields
      .filter((field) => NUMERIC_FIELDS.has(field.name))
      .map((field) => ({ name: field.name, value: text(field.value) })),
    heartbeats: oldestFirst.slice(-RECENT_HEARTBEATS).map(facts),
    notices: noticeCounts(oldestFirst),
    commit: commit && /^[0-9a-f]{7,40}$/i.test(commit) ? commit : null,
  };
}

/**
 * The rig as anything public names it: "Rig 7" from the server-owned number.
 * The venue note's "Venue" is the monitor's own word; a rig alert stored
 * before the number was recorded is "a rig", never its display name.
 */
export function publicRig(detail: AlertDetail): string {
  if (typeof detail.rigNumber === "number" && Number.isInteger(detail.rigNumber)) return `Rig ${detail.rigNumber}`;
  return detail.where === "Venue" ? "Venue" : "a rig";
}

/**
 * The headline with the rig's display name replaced by its public name and
 * the driver's by its stand-in, in one pass so neither can swallow part of
 * the other. The rules put the name in verbatim, so the replacement catches
 * it; should any of it survive - a name inside another word - the headline
 * becomes a fixed one.
 */
function publicHeadline(
  headline: string,
  displayName: string,
  seated: readonly StandIn[],
  where: string,
  title: string,
): string {
  // The venue note's headline lists rigs by display name; it is never
  // diagnosed (it is a warning), but it is not made public either.
  if (where === "Venue") return `${title} (${where})`;
  const name = oneLine(displayName);
  const standIns: StandIn[] = name ? [...seated, [name, where]] : [...seated];
  const survivor = name && serverText(standIns.map(([n]) => [n, " "]))(headline).includes(name);
  return survivor ? `${title} (${where})` : serverText(standIns)(headline);
}

function facts(row: HeartbeatRow): HeartbeatFacts {
  const p = row.payload;
  const out: HeartbeatFacts = { receivedAt: row.receivedAt, clockSkewMs: row.clockSkewMs };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
  const oneOf = (v: unknown, allowed: readonly string[]) =>
    typeof v === "string" && allowed.includes(v) ? v : undefined;
  const instant = (v: unknown) => {
    if (v === null) return null;
    const ms = typeof v === "string" ? Date.parse(v) : NaN;
    return Number.isFinite(ms) ? ms : undefined;
  };

  const set = <K extends keyof HeartbeatFacts>(key: K, value: HeartbeatFacts[K] | undefined) => {
    if (value !== undefined) out[key] = value;
  };
  set("agentVersion", typeof p.agentVersion === "string" && VERSION.test(p.agentVersion) ? p.agentVersion : undefined);
  set("processStartedAt", instant(p.processStartedAt) ?? undefined);
  set("sequence", num(p.sequence));
  set("startCount", num(p.startCount));
  set("osUptimeS", num(p.osUptimeS));
  set("telemetryMode", oneOf(p.telemetryMode, TELEMETRY_MODES));
  set("simConnected", bool(p.simConnected));
  set("telemetryFaulted", bool(p.telemetryFaulted));
  if (Array.isArray(p.missingVariables)) set("missingVariableCount", p.missingVariables.length);
  if ("session" in p) set("inSession", p.session !== null && typeof p.session === "object");
  set("assignmentKnown", bool(p.assignmentKnown));
  if ("assignmentId" in p) set("driverSeated", p.assignmentId !== null);
  set("pendingLaps", num(p.pendingLaps));
  set("oldestPendingAgeS", p.oldestPendingAgeS === null ? null : num(p.oldestPendingAgeS));
  set("rejectedLaps", num(p.rejectedLaps));
  set("checkout", oneOf(p.checkout, CHECKOUTS));
  set("lastLapCapturedAt", instant(p.lastLapCapturedAt));
  set("lastLapPostedAt", instant(p.lastLapPostedAt));
  set("signInFailures", num(p.signInFailures));
  if (Array.isArray(p.signInFailureKinds)) {
    set(
      "signInFailureKinds",
      p.signInFailureKinds.filter((k): k is string => typeof k === "string" && SIGN_IN_KINDS.includes(k)),
    );
  }
  set("agentCpuPercent", num(p.agentCpuPercent));
  set("agentMemoryMb", num(p.agentMemoryMb));
  set("shuttingDown", bool(p.shuttingDown));
  return out;
}

function noticeCounts(oldestFirst: readonly HeartbeatRow[]): IncidentContext["notices"] {
  const counts = new Map<NoticeCode, number>();
  for (const row of oldestFirst) {
    for (const notice of Array.isArray(row.payload.notices) ? row.payload.notices : []) {
      if (typeof notice !== "string") continue;
      const code = noticeCode(notice);
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  return [...counts].map(([code, count]) => ({ code, summary: NOTICE_CODES[code].summary, count }));
}

export function noticeCode(notice: string): NoticeCode {
  for (const [code, { prefix }] of Object.entries(NOTICE_CODES)) {
    if (prefix && notice.startsWith(prefix)) return code as NoticeCode;
  }
  return "other";
}

/** A one-lined name and what replaces it. */
type StandIn = readonly [name: string, standIn: string];

/**
 * The monitor's own words, made safe to send: one line, no control
 * characters, and each name replaced by its stand-in as a whole word, the
 * longest name first so a name that holds another is replaced whole.
 */
function serverText(standIns: readonly StandIn[]) {
  const names = [...standIns].sort(([a], [b]) => b.length - a.length);
  const alternatives = names.map(([name]) => `(${escape(name)})`).join("|");
  const pattern = names.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, "giu") : null;
  return (s: string) => {
    const line = oneLine(s);
    if (!pattern) return line;
    return line.replace(pattern, (...groups: unknown[]) => {
      const matched = groups.slice(1, names.length + 1).findIndex((group) => group !== undefined);
      return names[matched][1];
    });
  };
}

/** Control characters and line breaks become spaces, and runs of space one. */
export function oneLine(s: string): string {
  return s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
