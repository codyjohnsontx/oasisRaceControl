import { clip, DISCORD_LIMITS, type DiscordMessage } from "./discord";
import { duration, RULES, type AlertDetail, type Severity } from "./rules";

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
