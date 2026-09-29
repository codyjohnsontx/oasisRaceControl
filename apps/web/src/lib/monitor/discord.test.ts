import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertUserId, postDiscord, type DiscordMessage } from "./discord";

/**
 * The webhook client against Discord's own answers, served by a fake fetch -
 * no test ever posts to a real channel.
 *
 * RECORDED_400 is a real response: recorded 2026-09-29 by posting a message
 * with no content to the venue's webhook, which Discord refuses without
 * posting anything. The success response is not recorded, because recording
 * one means putting a message in the venue's channel; SUCCESS_204 is the
 * documented answer to Execute Webhook without `?wait=true` - 204 No Content
 * with the same rate-limit headers as the 400 carried.
 */
const RECORDED_400 = {
  status: 400,
  headers: {
    "content-type": "application/json",
    "x-ratelimit-bucket": "3d2712a9e4fe17cc9d3fed4a8e672e5f",
    "x-ratelimit-limit": "5",
    "x-ratelimit-remaining": "4",
    "x-ratelimit-reset": "1790662140",
    "x-ratelimit-reset-after": "1",
  },
  body: '{"message": "Cannot send an empty message", "code": 50006}',
};

const SUCCESS_204 = {
  status: 204,
  headers: {
    "x-ratelimit-bucket": "3d2712a9e4fe17cc9d3fed4a8e672e5f",
    "x-ratelimit-limit": "5",
    "x-ratelimit-remaining": "4",
    "x-ratelimit-reset": "1790662140",
    "x-ratelimit-reset-after": "1",
  },
  body: null,
};

const WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/secret-token-never-logged";

const MESSAGE: DiscordMessage = {
  content: "🟡 Rig 02: this iRacing build does not publish LapLastLapTime",
  allowed_mentions: { parse: [] },
};

function answering(recorded: { status: number; headers: Record<string, string>; body: string | null }) {
  return vi.fn(async () => new Response(recorded.body, { status: recorded.status, headers: recorded.headers }));
}

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
});

describe("postDiscord", () => {
  it("counts Discord's 204 as sent, posting the message as JSON to the webhook", async () => {
    const fetch = answering(SUCCESS_204);
    await expect(postDiscord(MESSAGE, { url: WEBHOOK, fetch })).resolves.toEqual({ status: "sent" });

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual(MESSAGE);
  });

  it("reports the recorded 400 as failed, with Discord's reason and never the webhook", async () => {
    const result = await postDiscord(MESSAGE, { url: WEBHOOK, fetch: answering(RECORDED_400) });
    expect(result).toEqual({
      status: "failed",
      reason: 'HTTP 400 {"message": "Cannot send an empty message", "code": 50006}',
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("reports a network failure without the error's text, which can quote the URL", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError(`fetch failed for ${WEBHOOK}`);
    });
    const result = await postDiscord(MESSAGE, { url: WEBHOOK, fetch });
    expect(result).toEqual({ status: "failed", reason: "unreachable (TypeError)" });
  });

  it("gives up on a post that takes too long", async () => {
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    const result = await postDiscord(MESSAGE, { url: WEBHOOK, fetch: fetch as unknown as typeof globalThis.fetch, timeoutMs: 20 });
    expect(result).toEqual({ status: "failed", reason: "timed out" });
  });

  it("sends nothing and says so when no webhook is configured", async () => {
    const fetch = vi.fn();
    const saved = process.env.DISCORD_WEBHOOK_URL;
    delete process.env.DISCORD_WEBHOOK_URL;
    try {
      await expect(postDiscord(MESSAGE, { fetch })).resolves.toEqual({ status: "not_configured" });
    } finally {
      if (saved !== undefined) process.env.DISCORD_WEBHOOK_URL = saved;
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "[monitor] DISCORD_WEBHOOK_URL is not set; would have posted:",
      MESSAGE.content,
    );
  });
});

describe("alertUserId", () => {
  it("accepts a Discord user id and nothing that could smuggle text into a message", () => {
    expect(alertUserId(" 123456789012345678 ")).toBe("123456789012345678");
    expect(alertUserId(undefined)).toBeNull();
    expect(alertUserId("")).toBeNull();
    expect(alertUserId("@everyone")).toBeNull();
    expect(alertUserId("123> hi <@456")).toBeNull();
  });
});
