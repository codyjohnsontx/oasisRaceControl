import { formatLapTime } from "@/lib/time";
import { clip, DISCORD_LIMITS, type DiscordMessage } from "./discord";
import { boardName, boardState, eventDisplays, type EventMode } from "./event-mode";
import { rigState } from "./rig-state";
import {
  driverName,
  duration,
  RULES,
  SILENT_AFTER_MS,
  SILENT_LOOKBACK_MS,
  type AlertDetail,
  type MonitorSnapshot,
  type RigSnapshot,
  type Severity,
} from "./rules";
import type { RoutineFacts } from "./store";

/**
 * What the channel shows for an alert, rendered from the stored row alone, so
 * a post retried after a Discord outage says exactly what the first attempt
 * would have. Pure, like the rules.
 */

export type AlertForMessage = {
  id: string;
  rule: string;
  severity: Severity;
  openedAt: number;
  resolvedAt: number | null;
  detail: AlertDetail;
};

const RED = 0xe74c3c;
const YELLOW = 0xf1c40f;

function ruleOf(rule: string): { number: string; title: string } {
  return RULES[rule as keyof typeof RULES] ?? { number: "?", title: rule };
}

/**
 * An alert opening. Urgent: red, and @mentions the owner so the phone pushes.
 * Warning: yellow and quiet - no mention at all.
 */
export function alertMessage(alert: AlertForMessage, mentionUserId: string | null): DiscordMessage {
  const rule = ruleOf(alert.rule);
  const urgent = alert.severity === "urgent";
  const mention = urgent && mentionUserId ? `<@${mentionUserId}> ` : "";
  return {
    content: clip(`${mention}${urgent ? "🔴" : "🟡"} ${alert.detail.headline}`, DISCORD_LIMITS.content),
    embeds: [
      {
        title: clip(rule.title, DISCORD_LIMITS.embedTitle),
        color: urgent ? RED : YELLOW,
        fields: [{ name: "Where", value: alert.detail.where }, ...alert.detail.fields]
          .slice(0, DISCORD_LIMITS.fields)
          .map((field) => ({
            name: clip(field.name, DISCORD_LIMITS.fieldName),
            value: clip(field.value || "-", DISCORD_LIMITS.fieldValue),
            inline: true,
          })),
        footer: { text: `alert #${alert.id} · rule ${rule.number}` },
      },
    ],
    allowed_mentions: mention ? { parse: [], users: [mentionUserId!] } : { parse: [] },
  };
}

/** The one message that closes an alert. Never mentions anyone. */
export function recoveryMessage(alert: AlertForMessage): DiscordMessage {
  const rule = ruleOf(alert.rule);
  const open = alert.resolvedAt === null ? "" : `, after ${duration(alert.resolvedAt - alert.openedAt)}`;
  return {
    content: clip(
      `🟢 Recovered: ${rule.title} - ${alert.detail.where} (alert #${alert.id}${open})`,
      DISCORD_LIMITS.content,
    ),
    allowed_mentions: { parse: [] },
  };
}

const GREEN = 0x2ecc71;

const venueClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hour: "numeric",
  minute: "2-digit",
});
const venueDay = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  month: "short",
  day: "numeric",
});

/** "3:40 PM", venue time: what everyone in the room reads off the wall clock. */
export function venueTime(at: number): string {
  return venueClock.format(at);
}

/** "Oct 4", the venue's calendar day. */
export function venueDate(at: number): string {
  return venueDay.format(at);
}

/** One grey line, no embed and no mention: event mode flips and the monitor's own notes. */
export function noteMessage(text: string): DiscordMessage {
  return { content: clip(text, DISCORD_LIMITS.content), allowed_mentions: { parse: [] } };
}

/** The one line that says event mode changed, and why. */
export function eventModeLine(mode: EventMode): string {
  switch (mode.cause) {
    case "board":
      return `⚪ Event mode on: ${boardName(mode.board)} opened at ${venueTime(mode.board.firstSeenAt)}`;
    case "override":
      return `⚪ Event mode ${mode.on ? "on" : "off"}: ${mode.on ? "started" : "stopped"} by ${
        mode.setBy ?? "staff"
      } until midnight`;
    case "none":
      return "⚪ Event mode off: no event board is open";
  }
}

/** Rule 9b's note: evaluations stopped for a while in venue hours. */
export function monitorGapLine(gap: { from: number; to: number }): string {
  const sameDay = venueDay.format(gap.from) === venueDay.format(gap.to);
  const from = sameDay ? venueTime(gap.from) : `${venueDay.format(gap.from)} ${venueTime(gap.from)}`;
  return (
    `🟡 Monitor gap: no checks ran from ${from} to ${venueTime(gap.to)} - ` +
    "is the outside clock (cron-job.org) still running?"
  );
}

/**
 * The routine update, every 20 minutes in event mode (R1, R7). A fixed
 * template, no AI (R4): the header line is the one-glance signal on a phone,
 * and the embed's colour follows the worst open alert.
 */
export function routineUpdateMessage(
  snapshot: MonitorSnapshot,
  facts: RoutineFacts,
  nextAt: number,
): DiscordMessage {
  const { now } = snapshot;
  const worst = facts.activeAlerts.some((a) => a.severity === "urgent")
    ? "urgent"
    : facts.activeAlerts.length > 0
      ? "warning"
      : "ok";
  const emoji = worst === "urgent" ? "🔴" : worst === "warning" ? "🟡" : "🟢";

  const combo = snapshot.featuredCombo
    ? [
        [snapshot.featuredCombo.trackName, snapshot.featuredCombo.trackConfig].filter(Boolean).join(" "),
        snapshot.featuredCombo.carName,
      ].join(" · ")
    : "no featured combo";
  const lines = [
    `Board: ${boardSummary(snapshot)} · ${combo} · ${drivers(facts.driversToday)} today · ` +
      `${facts.lapsLast20Min} ${facts.lapsLast20Min === 1 ? "lap" : "laps"} in the last 20 min`,
  ];

  let off = 0;
  for (const rig of snapshot.rigs) {
    const line = rigLine(now, rig, facts.lastLapAtByRig.get(rig.id) ?? null);
    if (line) lines.push(line);
    else off++;
  }
  if (off > 0) lines.push(`${off} other ${off === 1 ? "rig" : "rigs"} not on today`);

  lines.push(
    facts.top.length > 0
      ? `Top ${facts.top.length} today: ` +
          facts.top
            .map((t, i) => `${i + 1}. ${formatLapTime(t.lapTimeMs)} ${initials(t.displayName)}`)
            .join("  ")
      : "Top 3 today: no valid laps yet",
  );
  lines.push(
    facts.activeAlerts.length > 0
      ? `Active alerts: ${facts.activeAlerts
          .map((a) => `${a.severity === "urgent" ? "🔴" : "🟡"} ${a.headline}`)
          .join("\n")}`
      : "Active alerts: none",
  );

  return {
    content: clip(
      `${emoji} Oasis event update · ${venueTime(now)}  (next about ${venueTime(nextAt)})`,
      DISCORD_LIMITS.content,
    ),
    embeds: [
      {
        description: clip(lines.join("\n"), DISCORD_LIMITS.embedDescription),
        color: worst === "urgent" ? RED : worst === "warning" ? YELLOW : GREEN,
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

/** The event's display, as the update's first line names it. */
function boardSummary(snapshot: MonitorSnapshot): string {
  const displays = eventDisplays(snapshot);
  if (displays.length === 0) return "none open";
  const states = displays.map((b) => ({ b, state: boardState(b, snapshot.now) }));
  const live = states.find((s) => s.state === "live");
  if (live) {
    const notes = [
      live.b.feedFailures > 0 ? "feed failing" : null,
      live.b.visible === false ? "hidden tab" : null,
    ].filter(Boolean);
    return notes.length > 0 ? `live (${notes.join(", ")})` : "live";
  }
  const dark = states.filter((s) => s.state === "dark").sort((x, y) => y.b.lastSeenAt - x.b.lastSeenAt)[0];
  return dark ? `dark ${duration(snapshot.now - dark.b.lastSeenAt)}` : "closed";
}

/**
 * One rig's line, or null for a rig that has not been on today: at an event
 * the shop's other rigs are off, and twenty lines of "off" bury the two that
 * matter.
 */
function rigLine(now: number, rig: RigSnapshot, lastLapAt: number | null): string | null {
  if (rig.lastSeenAt === null || (now - rig.lastSeenAt > SILENT_LOOKBACK_MS && !rig.seated)) {
    return null;
  }
  const state = rigState(rig.heartbeats);
  const quiet = now - rig.lastSeenAt;
  const status = state?.shuttingDown
    ? "agent closed"
    : quiet <= SILENT_AFTER_MS
      ? "online"
      : `silent ${duration(quiet)}`;
  const sim =
    state === null || state.simConnected === null
      ? "iRacing unknown (agent too old to report)"
      : !state.simConnected
        ? "iRacing not running"
        : state.session
          ? "iRacing in session"
          : "iRacing idle";
  const driver = rig.seated
    ? `${driverName(rig.seated)} (seated ${duration(now - rig.seated.startedAt)})`
    : "nobody signed in";
  const lap = lastLapAt === null ? "no laps today" : `last lap ${venueTime(lastLapAt)}`;
  const queue =
    state?.pendingLaps == null
      ? "queue ?"
      : `queue ${state.pendingLaps}${state.rejectedLaps ? `, ${state.rejectedLaps} parked` : ""}`;
  const agent = `agent ${state?.agentVersion?.replace(/^rig-agent\//, "") ?? "?"}`;
  // A closed agent's goodbye says nothing current about iRacing.
  const parts = state?.shuttingDown
    ? [status, driver, lap, queue, agent]
    : [status, sim, driver, lap, queue, agent];
  return `${rig.name}  ${parts.join(" · ")}`;
}

function drivers(n: number): string {
  return n === 1 ? "1 driver" : `${n} drivers`;
}

/** "Matt Garcia" → "M.G.": the top three by initials, as the plan's template shows them. */
function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .filter(Boolean);
  return letters.length > 0 ? `${letters.join(".")}.` : "?";
}
