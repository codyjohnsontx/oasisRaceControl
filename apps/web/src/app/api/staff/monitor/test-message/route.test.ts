import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Send test message to Discord". What must hold: only staff, from the staff
 * page's own origin; the message names who sent it and mentions nobody; and
 * the answer is what Discord actually did - a missing webhook or a refusal is
 * never reported as sent.
 */

const getStaffUser = vi.fn();
const postDiscord = vi.fn();

vi.mock("@/lib/staff", () => ({ getStaffUser: () => getStaffUser() }));
vi.mock("@/lib/monitor/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/monitor/discord")>()),
  postDiscord: (m: unknown) => postDiscord(m),
}));

const { POST } = await import("./route");

function post(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/staff/monitor/test-message", {
    method: "POST",
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json", ...headers },
    body: "{}",
  });
}

beforeEach(() => {
  getStaffUser.mockReset().mockResolvedValue({ userId: "u1", displayName: "Cody" });
  postDiscord.mockReset().mockResolvedValue({ status: "sent" });
});

describe("POST /api/staff/monitor/test-message", () => {
  it("refuses another origin before looking at the session", async () => {
    expect((await POST(post({ origin: "http://evil.test" }))).status).toBe(403);
    expect(getStaffUser).not.toHaveBeenCalled();
    expect(postDiscord).not.toHaveBeenCalled();
  });

  it("refuses anyone who is not signed in as staff", async () => {
    getStaffUser.mockResolvedValue(null);
    expect((await POST(post())).status).toBe(403);
    expect(postDiscord).not.toHaveBeenCalled();
  });

  it("posts one quiet line naming the staff member, and says it was sent", async () => {
    const response = await POST(post());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "sent" });
    expect(postDiscord).toHaveBeenCalledWith({
      content: "🔧 Test message from /staff/rigs by Cody",
      allowed_mentions: { parse: [] },
    });
  });

  it("says the webhook is not configured rather than sent", async () => {
    postDiscord.mockResolvedValue({ status: "not_configured" });
    const response = await POST(post());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "not_configured" });
  });

  it("passes on Discord's refusal and its reason", async () => {
    postDiscord.mockResolvedValue({ status: "failed", reason: "HTTP 404 Unknown Webhook" });
    const response = await POST(post());
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ status: "failed", reason: "HTTP 404 Unknown Webhook" });
  });
});
