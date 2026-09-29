/**
 * The one way anything reaches the venue's Discord channel: an incoming
 * webhook, whose URL is the credential. It comes only from DISCORD_WEBHOOK_URL
 * (a Vercel environment variable the owner sets) and is never written to the
 * repository, a log line or an error. A deployment without it - a preview, a
 * laptop - logs what it would have sent and sends nothing, so no preview can
 * post to the venue.
 *
 * The limits below are Discord's own (Execute Webhook and the message
 * object): past any of them the whole post is refused with a 400, so every
 * message is clipped to fit here rather than lost there.
 */

export const DISCORD_LIMITS = {
  content: 2000,
  embedTitle: 256,
  embedDescription: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
} as const;

/** How long a post may take before it counts as failed and is retried later. */
const POST_TIMEOUT_MS = 10_000;

export type DiscordEmbed = {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
};

/**
 * Always carries allowed_mentions: without it Discord pings whatever the text
 * happens to contain. Only an urgent alert lists a user, and only that user.
 */
export type DiscordMessage = {
  content?: string;
  embeds?: DiscordEmbed[];
  allowed_mentions: { parse: [] } | { parse: []; users: string[] };
};

export type DiscordResult =
  | { status: "sent" }
  | { status: "not_configured" }
  | { status: "failed"; reason: string };

/** The Discord user an urgent alert @mentions, if a valid id is configured. */
export function alertUserId(raw = process.env.DISCORD_ALERT_USER_ID): string | null {
  const id = raw?.trim();
  // A snowflake: digits only. Anything else would be pasted into the message.
  return id && /^\d{5,25}$/.test(id) ? id : null;
}

export function discordConfigured(url = process.env.DISCORD_WEBHOOK_URL): boolean {
  return Boolean(url?.trim());
}

/**
 * Posts one message. Resolves - never throws - with whether Discord took it:
 * `sent` only on a 2xx (204 No Content, since the post does not ask Discord to
 * wait for the message object), `failed` with a reason safe to log on anything
 * else, including a 429, which the caller's next evaluation retries.
 */
export async function postDiscord(
  message: DiscordMessage,
  options: { url?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<DiscordResult> {
  const url = (options.url ?? process.env.DISCORD_WEBHOOK_URL)?.trim();
  if (!url) {
    console.log("[monitor] DISCORD_WEBHOOK_URL is not set; would have posted:", preview(message));
    return { status: "not_configured" };
  }

  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(options.timeoutMs ?? POST_TIMEOUT_MS),
    });
    if (response.ok) return { status: "sent" };
    // Discord's error body is JSON with a code and a message and never echoes
    // the webhook token, so it is safe to log and is what says what was wrong.
    const body = (await response.text().catch(() => "")).slice(0, 300);
    return { status: "failed", reason: `HTTP ${response.status}${body ? ` ${body}` : ""}` };
  } catch (error) {
    // Deliberately not the error itself: undici can quote the request URL.
    const name = error instanceof Error ? error.name : "Error";
    return { status: "failed", reason: name === "TimeoutError" ? "timed out" : `unreachable (${name})` };
  }
}

function preview(message: DiscordMessage): string {
  return [message.content, ...(message.embeds ?? []).map((e) => e.title)].filter(Boolean).join(" | ");
}

/** Cuts text to Discord's limit, marking the cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}
