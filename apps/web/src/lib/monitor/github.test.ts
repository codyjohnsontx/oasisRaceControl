import { describe, expect, it, vi } from "vitest";
import badCredentials from "./fixtures/github-bad-credentials.json";
import commentCreated from "./fixtures/github-comment-created.json";
import issueCreated from "./fixtures/github-issue-created.json";
import { commentOnIssue, openIssue } from "./github";

/**
 * The issue client against GitHub's own answers, served by a fake fetch - no
 * test ever calls GitHub, and nothing here files an issue.
 *
 * Recorded 2026-09-29: github-bad-credentials.json is the 401 GitHub gave a
 * POST to this repository's issues with an invalid token (which files
 * nothing). The two 201 bodies are the issue and comment objects GitHub
 * answered for GET issues/42 and its first comment, trimmed to the fields
 * that matter, because recording a create means filing one on the real
 * repository; a create answers with the same object. Edited to fit a
 * rig-alert: the title, the comment's body and html_url, and the label, whose
 * shape is the documented label object.
 */

const TOKEN = "github_pat_never_logged";
const ISSUE = { title: "[rig-alert] Laps queued but not reaching the site - Rig 02", body: "handoff" };

function answering(status: number, body: unknown) {
  return vi.fn(async () => Response.json(body, { status }));
}

describe("openIssue", () => {
  it("files the issue with the rig-alert label and reads its number from GitHub's 201", async () => {
    const fetch = answering(201, issueCreated);
    await expect(openIssue(ISSUE, { token: TOKEN, fetch })).resolves.toEqual({
      status: "sent",
      number: 42,
      labelled: true,
    });

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/codyjohnsontx/oasisRaceControl/issues");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("user-agent")).toBeTruthy();
    expect(JSON.parse(init.body as string)).toEqual({ ...ISSUE, labels: ["rig-alert"] });
  });

  it("says when GitHub filed the issue without the label", async () => {
    const fetch = answering(201, { ...issueCreated, labels: [] });
    await expect(openIssue(ISSUE, { token: TOKEN, fetch })).resolves.toMatchObject({ labelled: false });
  });

  it("reports the recorded 401 as failed, with GitHub's reason and never the token", async () => {
    const result = await openIssue(ISSUE, { token: TOKEN, fetch: answering(401, badCredentials) });
    expect(result).toMatchObject({ status: "failed", reason: expect.stringMatching(/^HTTP 401 .*Bad credentials/) });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("gives up on a call that takes too long", async () => {
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    const result = await openIssue(ISSUE, {
      token: TOKEN,
      fetch: fetch as unknown as typeof globalThis.fetch,
      timeoutMs: 20,
    });
    expect(result).toEqual({ status: "failed", reason: "timed out" });
  });

  it("calls nothing without a token", async () => {
    const fetch = vi.fn();
    await expect(openIssue(ISSUE, { token: " ", fetch })).resolves.toEqual({ status: "not_configured" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("commentOnIssue", () => {
  it("comments on the numbered issue", async () => {
    const fetch = answering(201, commentCreated);
    await expect(commentOnIssue(42, "recovered", { token: TOKEN, fetch })).resolves.toEqual({ status: "sent" });

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/codyjohnsontx/oasisRaceControl/issues/42/comments");
    expect(JSON.parse(init.body as string)).toEqual({ body: "recovered" });
  });
});
