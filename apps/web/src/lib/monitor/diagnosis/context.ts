import { createHash } from "node:crypto";
import { RULES, type AlertDetail, type Severity } from "../rules";

/**
 * What an urgent alert's AI diagnosis and copy-paste handoff are written from,
 * with every driver's name and every id taken out first (plan decision D9).
 * The owner chose Gemini's free tier on the premise that the prompt carries no
 * customer data, and that tier's prompts may be used by Google - so the
 * premise is made true here, once, before anything leaves: a driver's display
 * name becomes `driver-<4 hex>` and a uuid becomes `<id>`. The handoff is
 * built from the same redacted context, because it also goes to the coding
 * harness and, later, to a GitHub issue on a public repository.
 *
 * Only named heartbeat fields are carried (`HEARTBEAT_FIELDS`): the payload
 * holds the assignment id, which is dropped and replaced by whether anyone
 * was seated.
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

export type IncidentContext = {
  alertId: string;
  rule: { key: string; number: string; title: string };
  severity: Severity;
  openedAt: number;
  where: string;
  headline: string;
  fields: Array<{ name: string; value: string }>;
  /** Oldest first; at most RECENT_HEARTBEATS. */
  heartbeats: Array<{ receivedAt: number; clockSkewMs: number | null } & Record<string, unknown>>;
  /** Agent notices from the heartbeats read, oldest first, at most MAX_NOTICES. */
  notices: string[];
  /** The deployed commit (VERCEL_GIT_COMMIT_SHA), or null off Vercel. */
  commit: string | null;
};

/** The heartbeats a prompt shows in full. */
export const RECENT_HEARTBEATS = 5;
const MAX_NOTICES = 10;

/** Payload fields that describe the rig and its agent, and nothing about a person. */
const HEARTBEAT_FIELDS = [
  "agentVersion",
  "processStartedAt",
  "sequence",
  "startCount",
  "osUptimeS",
  "telemetryMode",
  "simConnected",
  "telemetryFaulted",
  "missingVariables",
  "session",
  "assignmentKnown",
  "pendingLaps",
  "oldestPendingAgeS",
  "rejectedLaps",
  "checkout",
  "lastLapCapturedAt",
  "lastLapPostedAt",
  "signInFailures",
  "signInFailureKinds",
  "agentCpuPercent",
  "agentMemoryMb",
  "shuttingDown",
] as const;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

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
  const redact = redactor(alert.detail.driver);
  const rule = RULES[alert.rule as keyof typeof RULES] ?? { number: "?", title: alert.rule };
  const oldestFirst = [...heartbeats].reverse();

  return redact({
    alertId: alert.id,
    rule: { key: alert.rule, number: rule.number, title: rule.title },
    severity: alert.severity,
    openedAt: alert.openedAt,
    where: alert.detail.where,
    headline: alert.detail.headline,
    fields: alert.detail.fields,
    heartbeats: oldestFirst.slice(-RECENT_HEARTBEATS).map((row) => {
      const kept: Record<string, unknown> = {};
      for (const key of HEARTBEAT_FIELDS) {
        if (row.payload[key] !== undefined) kept[key] = row.payload[key];
      }
      if ("assignmentId" in row.payload) kept.driverSeated = row.payload.assignmentId !== null;
      return { receivedAt: row.receivedAt, clockSkewMs: row.clockSkewMs, ...kept };
    }),
    notices: oldestFirst
      .flatMap((row) => (Array.isArray(row.payload.notices) ? row.payload.notices : []))
      .filter((n): n is string => typeof n === "string")
      .slice(-MAX_NOTICES),
    commit,
  });
}

/** Rewrites every string in a value: ids out, the driver's name out. */
function redactor(driver: string | undefined) {
  const name = driver?.trim()
    ? new RegExp(`(?<![\\p{L}\\p{N}])${escape(driver.trim())}(?![\\p{L}\\p{N}])`, "giu")
    : null;
  const text = (s: string) => {
    const out = s.replace(UUID, "<id>");
    return name ? out.replace(name, pseudonym(driver!.trim())) : out;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return <T>(value: T) => walk(value) as T;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
