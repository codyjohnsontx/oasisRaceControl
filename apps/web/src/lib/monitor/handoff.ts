import { clip, DISCORD_LIMITS, type DiscordMessage } from "./discord";
import type { IncidentContext } from "./diagnosis/context";
import type { Diagnosis, DiagnosisResult } from "./diagnosis";
import type { ProviderName } from "./diagnosis/provider";
import { duration, RULES } from "./rules";
import { VENUE_TIMEZONE } from "@/lib/venue";

/**
 * The two messages that follow an urgent alert once it has a diagnosis (owner
 * decision R4, option B): the diagnosis itself, for staff, and the handoff -
 * one fenced block to copy and paste into the coding harness. The handoff is a
 * fixed frame the monitor fills from what it saw; the model contributes only
 * the cause, the suggested change and where to look, because a model on the
 * server has no repository and cannot be trusted to invent the rest.
 *
 * Both are rendered from the redacted context (diagnosis/context.ts), so a
 * handoff pasted anywhere - a harness, a public GitHub issue - names no driver.
 */

export const REPOSITORY = "codyjohnsontx/oasisRaceControl";

/** The handoff block's text; the fence around it takes the rest of Discord's 2000. */
export const HANDOFF_MAX = 1900;

const PURPLE = 0x9b59b6;
const PROVIDER_LABEL: Record<ProviderName, string> = { gemini: "Gemini", anthropic: "Claude" };

export function handoffText(context: IncidentContext, outcome: DiagnosisResult): string {
  const latest = context.heartbeats.at(-1);
  const agent = typeof latest?.agentVersion === "string" ? latest.agentVersion : "unknown";
  const lines = [
    `Oasis rig alert #${context.alertId} - rule ${context.rule.number}: ${context.rule.title} (${context.where})`,
    `Opened ${utc(context.openedAt)} (${venueClock(context.openedAt)} venue) · agent ${agent}`,
    `Site commit: ${context.commit ? context.commit.slice(0, 7) : "unknown"} · repo ${REPOSITORY}`,
    `What the monitor saw: ${clip(context.headline, 300)}`,
    `Rig state (last 3 heartbeats): ${heartbeatSummary(context)}`,
    `Recent agent notices: ${clip(context.notices.join(" | ") || "none", 400)}`,
  ];
  if (outcome.ok) {
    const d = outcome.diagnosis;
    lines.push(
      `Likely cause (AI, confidence ${d.confidence}): ${clip(d.likelyCause, 300)}`,
      `Suggested change: ${clip(d.suggestedChange, 500)}`,
      `Where to look: ${clip(d.whereToLook.join(", ") || "-", 250)}`,
    );
  } else {
    lines.push(`Likely cause (AI): no diagnosis (${outcome.error})`);
  }
  lines.push(
    "Rules: reproduce end-to-end first (CLAUDE.md); fix on a branch and open a PR; do not touch the hosted database; the owner approves every merge.",
  );
  // A fence inside the text would end the code block early.
  return clip(lines.join("\n").replaceAll("```", "'''"), HANDOFF_MAX);
}

/** The copy-paste message: the handoff alone, in one block, pinging no one. */
export function handoffMessage(handoff: string): DiscordMessage {
  return { content: `\`\`\`text\n${handoff}\n\`\`\``, allowed_mentions: { parse: [] } };
}

/** The diagnosis, for staff reading the channel. Never mentions anyone. */
export function diagnosisMessage(
  alert: { id: string; rule: string },
  diagnosis: Diagnosis,
  provider: ProviderName,
): DiscordMessage {
  const rule = RULES[alert.rule as keyof typeof RULES]?.number ?? "?";
  return {
    embeds: [
      {
        title: clip(
          `Likely cause (${PROVIDER_LABEL[provider]}, confidence ${diagnosis.confidence})`,
          DISCORD_LIMITS.embedTitle,
        ),
        description: clip(
          `${diagnosis.summary}\n\n**Suggested change:** ${diagnosis.suggestedChange}`,
          DISCORD_LIMITS.embedDescription,
        ),
        color: PURPLE,
        footer: { text: `alert #${alert.id} · rule ${rule}` },
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

/** GitHub's own limit on an issue title. */
const ISSUE_TITLE_MAX = 256;

/**
 * The rig-alert issue (plan section 11): the handoff, and the redacted
 * heartbeat rows it was written from, for the coding harness to read. Built
 * from the same redacted context as the handoff, since the repository is
 * public.
 */
export function rigAlertIssue(context: IncidentContext, handoff: string): { title: string; body: string } {
  return {
    title: clip(`[rig-alert] ${context.rule.title} - ${context.where}`, ISSUE_TITLE_MAX),
    body: `Filed by the rig monitor for alert #${context.alertId} (docs/monitoring.md). Close this issue when the fix has merged; a recovery only comments.\n\n${incidentSection(context, handoff)}`,
  };
}

/** A later alert on the same rule and rig, commented on the open issue instead of filing another. */
export function refireComment(context: IncidentContext, handoff: string): string {
  return `Fired again as alert #${context.alertId}.\n\n${incidentSection(context, handoff)}`;
}

export function recoveryComment(alert: { id: string; openedAt: number; resolvedAt: number | null }): string {
  const after = alert.resolvedAt === null ? "" : ` after ${duration(alert.resolvedAt - alert.openedAt)}`;
  return `Alert #${alert.id} recovered${after}. The issue stays open for the fix; close it when that has merged.`;
}

function incidentSection(context: IncidentContext, handoff: string): string {
  const rows = JSON.stringify(context.heartbeats, null, 2).replaceAll("```", "'''");
  return [
    "```text",
    handoff,
    "```",
    "",
    "<details><summary>Latest heartbeats (redacted, oldest first)</summary>",
    "",
    "```json",
    rows,
    "```",
    "",
    "</details>",
  ].join("\n");
}

function heartbeatSummary(context: IncidentContext): string {
  const recent = context.heartbeats.slice(-3);
  if (recent.length === 0) return "none received";
  return recent
    .map((h) => {
      const parts = [utcTime(h.receivedAt)];
      if (h.shuttingDown === true) parts.push("goodbye");
      if (typeof h.simConnected === "boolean") parts.push(h.simConnected ? "sim connected" : "sim not connected");
      if (typeof h.pendingLaps === "number") {
        const age = typeof h.oldestPendingAgeS === "number" ? ` (oldest ${h.oldestPendingAgeS} s)` : "";
        parts.push(`pending ${h.pendingLaps}${age}`);
      }
      if (typeof h.rejectedLaps === "number" && h.rejectedLaps > 0) parts.push(`parked ${h.rejectedLaps}`);
      if (h.telemetryFaulted === true) parts.push("telemetry faulted");
      if (h.clockSkewMs !== null) parts.push(`skew ${h.clockSkewMs >= 0 ? "+" : ""}${(h.clockSkewMs / 1000).toFixed(1)} s`);
      return parts.join(", ");
    })
    .join("; ");
}

/** 2026-10-04 21:14 UTC */
function utc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** 21:14:05 */
function utcTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

/**
 * 4:14 PM on the venue's clock, assembled from parts: Intl's own joined form
 * puts a narrow no-break space before "PM" on some ICU versions, and the
 * handoff is meant to be byte-for-byte the same wherever it is rendered.
 */
function venueClock(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: VENUE_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(ms));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("hour")}:${part("minute")} ${part("dayPeriod").toUpperCase()}`;
}
