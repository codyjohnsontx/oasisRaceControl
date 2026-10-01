import { formatLapTime } from "@/lib/time";
import { comboMismatch } from "@/lib/validity";
import { clip, DISCORD_LIMITS, type DiscordMessage } from "./discord";
import { comboLabel, duration, nameOf, RULES, type AlertDetail, type FeaturedCombo, type Severity } from "./rules";

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
  /** Earlier openings on the same rule and subject in the hour before this one. */
  refireCount: number;
  /** Inside a flapping mute right now: announced by flappingMessage, and not recovered aloud. */
  flapping: boolean;
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

/**
 * What announces an alert that opened once too often in an hour: one quiet
 * line in place of the alert, saying the rule and subject are muted for the
 * hour. Everything on them in that hour stays in monitor_alerts (and on the
 * Rig health page) without being posted.
 */
export function flappingMessage(alert: AlertForMessage): DiscordMessage {
  const rule = ruleOf(alert.rule);
  return {
    content: clip(
      `🔕 Flapping: ${rule.title} - ${alert.detail.where} has fired ${alert.refireCount + 1} times ` +
        `in the last hour; muted for 1 h (alert #${alert.id} · rule ${rule.number})`,
      DISCORD_LIMITS.content,
    ),
    allowed_mentions: { parse: [] },
  };
}

/** How an alert opening is announced: itself, or the flapping line that mutes it. */
export function openingMessage(alert: AlertForMessage, mentionUserId: string | null): DiscordMessage {
  return alert.flapping ? flappingMessage(alert) : alertMessage(alert, mentionUserId);
}

/** Every lap of one rule 14 flapping mute, read when the mute ends (claimFastLapSummaries). */
export type FastLapSummary = {
  /** The alert that started the mute. */
  id: string;
  rigName: string;
  /** Today's featured combo, or null when none is set. */
  featuredCombo: FeaturedCombo | null;
  laps: Array<{ lapTimeMs: number; driver: { name: string; status: string } | null; combo: FeaturedCombo }>;
};

/**
 * The one quiet message that ends a rule 14 mute: every lap flagged while it
 * held, so a run of fast laps reaches staff once instead of flooding the
 * channel. A lap's car and track are the rig's own strings, so they are never
 * shown: a lap on today's featured combo says so with the combo's label, and
 * any other says "another car and track".
 */
export function fastLapSummaryMessage(summary: FastLapSummary): DiscordMessage {
  const rule = ruleOf("fast_lap");
  const featured = summary.featuredCombo;
  const lines = summary.laps.map((lap) => {
    const onFeatured =
      featured !== null &&
      comboMismatch(
        { track_name: featured.trackName, track_config: featured.trackConfig, car_name: featured.carName },
        lap.combo,
      ) === null;
    const driver = lap.driver ? nameOf(lap.driver.name, lap.driver.status) : "nobody signed in";
    const combo = onFeatured ? `today's featured combo (${comboLabel(featured)})` : "another car and track";
    return `• ${summary.rigName} · ${formatLapTime(lap.lapTimeMs)} by ${driver} on ${combo}`;
  });
  const count = summary.laps.length === 1 ? "1 lap" : `${summary.laps.length} laps`;
  return {
    content: clip(
      `🟡 ${summary.rigName}: ${count} flagged as implausibly fast while the rule was muted - worth a look; ` +
        "they rank unless staff invalidate them",
      DISCORD_LIMITS.content,
    ),
    embeds: [
      {
        title: clip(rule.title, DISCORD_LIMITS.embedTitle),
        color: YELLOW,
        description: clip(lines.join("\n"), DISCORD_LIMITS.embedDescription),
        footer: { text: `alert #${summary.id} · rule ${rule.number}` },
      },
    ],
    allowed_mentions: { parse: [] },
  };
}
