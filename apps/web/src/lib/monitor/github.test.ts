import { describe, expect, it, vi } from "vitest";
import badCredentials from "./fixtures/github-bad-credentials.json";
import commentCreated from "./fixtures/github-comment-created.json";
import issueCreated from "./fixtures/github-issue-created.json";
import { commentOnIssue, findIssueWithMarker, hasCommentWithMarker, openIssue, reopenIssue } from "./github";

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
 * shape is the documented label object. A closed issue is that object with
 * `state: "closed"`, as GET answers for one.
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

  it("reports the recorded 401 as failed by its status alone", async () => {
    const result = await openIssue(ISSUE, { token: TOKEN, fetch: answering(401, badCredentials) });
    expect(result).toEqual({ status: "failed", reason: "HTTP 401" });
  });

  it("never keeps an error body, even one that echoes the token and the issue", async () => {
    const fetch = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Response(`upstream echoed ${TOKEN} ${init.body as string}`, { status: 502 }),
    );
    const result = await openIssue(ISSUE, { token: TOKEN, fetch: fetch as unknown as typeof globalThis.fetch });
    expect(result).toEqual({ status: "failed", reason: "HTTP 502" });
    const text = JSON.stringify(result);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(ISSUE.title);
    expect(text).not.toContain(ISSUE.body);
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

describe("reopenIssue", () => {
  const closed = { ...issueCreated, state: "closed", state_reason: "completed" };

  it("reopens a closed issue", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(closed, { status: 200 }))
      .mockResolvedValueOnce(Response.json(issueCreated, { status: 200 }));
    await expect(reopenIssue(42, { token: TOKEN, fetch })).resolves.toEqual({ status: "sent" });

    const [[getUrl, get], [patchUrl, patch]] = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(getUrl).toBe("https://api.github.com/repos/codyjohnsontx/oasisRaceControl/issues/42");
    expect(get.method).toBe("GET");
    expect(get.body).toBeUndefined();
    expect(patchUrl).toBe("https://api.github.com/repos/codyjohnsontx/oasisRaceControl/issues/42");
    expect(patch.method).toBe("PATCH");
    expect(JSON.parse(patch.body as string)).toEqual({ state: "open" });
  });

  it("leaves an open issue alone", async () => {
    const fetch = answering(200, issueCreated);
    await expect(reopenIssue(42, { token: TOKEN, fetch })).resolves.toEqual({ status: "sent" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports a refused read as failed and changes nothing", async () => {
    const fetch = answering(401, badCredentials);
    await expect(reopenIssue(42, { token: TOKEN, fetch })).resolves.toMatchObject({ status: "failed" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("the marker lookups", () => {
  const MARKER = "<!-- oasis-rig-alert:issue:alert-7 -->";
  const SINCE = Date.parse("2026-09-29T07:00:00Z");

  it("finds the issue carrying the marker, never a pull request that quotes it", async () => {
    const fetch = answering(200, [
      { ...issueCreated, number: 45, body: `quoted ${MARKER}`, pull_request: { url: "x" } },
      { ...issueCreated, number: 44, body: "another alert <!-- oasis-rig-alert:issue:alert-70 -->" },
      { ...issueCreated, number: 43, body: `handoff\n\n${MARKER}` },
    ]);
    await expect(findIssueWithMarker(MARKER, SINCE, { token: TOKEN, fetch })).resolves.toEqual({
      status: "sent",
      number: 43,
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("GET");
    const query = new URL(url).searchParams;
    expect(query.get("state")).toBe("all");
    expect(query.get("since")).toBe("2026-09-29T07:00:00.000Z");
  });

  it("answers no issue when none carries it, and fails when the list cannot be read", async () => {
    await expect(
      findIssueWithMarker(MARKER, SINCE, { token: TOKEN, fetch: answering(200, [issueCreated]) }),
    ).resolves.toEqual({ status: "sent", number: null });
    await expect(
      findIssueWithMarker(MARKER, SINCE, { token: TOKEN, fetch: answering(401, badCredentials) }),
    ).resolves.toEqual({ status: "failed", reason: "HTTP 401" });
  });

  it("says whether the issue already has a comment carrying the marker", async () => {
    const marker = "<!-- oasis-rig-alert:recovery:alert-7 -->";
    const fetch = answering(200, [commentCreated, { ...commentCreated, body: `recovered\n\n${marker}` }]);
    await expect(hasCommentWithMarker(42, marker, SINCE, { token: TOKEN, fetch })).resolves.toEqual({
      status: "sent",
      found: true,
    });
    const [url] = fetch.mock.calls[0] as unknown as [string];
    expect(url.startsWith("https://api.github.com/repos/codyjohnsontx/oasisRaceControl/issues/42/comments?")).toBe(true);
    await expect(
      hasCommentWithMarker(42, marker, SINCE, { token: TOKEN, fetch: answering(200, [commentCreated]) }),
    ).resolves.toEqual({ status: "sent", found: false });
  });
});
