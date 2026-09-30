import { describe, expect, it, vi } from "vitest";
import badCredentials from "./fixtures/github-bad-credentials.json";
import commentCreated from "./fixtures/github-comment-created.json";
import issueCreated from "./fixtures/github-issue-created.json";
import {
  commentOnIssue,
  findIssueWithMarker,
  hasCommentWithMarker,
  MARKER_MAX_PAGES,
  openIssue,
  reopenIssue,
} from "./github";

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
  const MONITOR = { login: "oasis-monitor" };
  const LABELS = issueCreated.labels;
  let tokens = 0;

  /** A fresh token per test, so the account read is not served from an earlier test. */
  function token() {
    return `github_pat_lookup_${++tokens}`;
  }

  /** Answers GET /user with the monitor's account, and each list page from `pages`. */
  function github(pages: unknown[][]) {
    return vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/user") return Response.json(MONITOR);
      return Response.json(pages[Number(u.searchParams.get("page")) - 1] ?? []);
    }) as unknown as typeof globalThis.fetch & ReturnType<typeof vi.fn>;
  }

  const filed = (number: number, body: string, extra: object = {}) => ({
    ...issueCreated,
    number,
    body,
    user: MONITOR,
    labels: LABELS,
    ...extra,
  });

  it("finds only the monitor's own issue with the marker as its last line", async () => {
    const fetch = github([
      [
        filed(49, `quoted ${MARKER}`, { pull_request: { url: "x" } }),
        filed(48, `handoff\n\n${MARKER}`, { user: { login: "someone-else" }, labels: [] }),
        filed(47, `the handoff quotes ${MARKER} and goes on\n\n<!-- oasis-rig-alert:issue:alert-8 -->`),
        filed(46, "another alert <!-- oasis-rig-alert:issue:alert-70 -->"),
        filed(43, `handoff\n\n${MARKER}\n`),
      ],
    ]);
    await expect(findIssueWithMarker(MARKER, SINCE, { token: token(), fetch })).resolves.toEqual({
      status: "sent",
      number: 43,
      labelled: true,
    });
    const list = new URL((fetch.mock.calls as unknown as Array<[string]>)[1]![0]);
    expect(list.pathname).toBe("/repos/codyjohnsontx/oasisRaceControl/issues");
    expect(list.searchParams.get("state")).toBe("all");
    expect(list.searchParams.get("since")).toBe("2026-09-29T07:00:00.000Z");
  });

  it("ignores a stranger's issue carrying the exact marker", async () => {
    const fetch = github([[filed(48, `handoff\n\n${MARKER}`, { user: { login: "someone-else" } })]]);
    await expect(findIssueWithMarker(MARKER, SINCE, { token: token(), fetch })).resolves.toMatchObject({
      number: null,
    });
  });

  it("reports an unlabelled issue of its own as found but unlabelled", async () => {
    const fetch = github([[filed(43, `handoff\n\n${MARKER}`, { labels: [] })]]);
    await expect(findIssueWithMarker(MARKER, SINCE, { token: token(), fetch })).resolves.toEqual({
      status: "sent",
      number: 43,
      labelled: false,
    });
  });

  it("reads the next page until the marker turns up, and gives up after the cap", async () => {
    const other = (n: number) => filed(1000 + n, "someone else's alert");
    const fullPage = Array.from({ length: 100 }, (_, n) => other(n));
    const found = github([fullPage, [filed(43, `handoff\n\n${MARKER}`)]]);
    await expect(findIssueWithMarker(MARKER, SINCE, { token: token(), fetch: found })).resolves.toMatchObject({
      number: 43,
    });

    const endless = github(Array.from({ length: MARKER_MAX_PAGES + 1 }, () => fullPage));
    await expect(findIssueWithMarker(MARKER, SINCE, { token: token(), fetch: endless })).resolves.toEqual({
      status: "failed",
      reason: `marker not found in ${MARKER_MAX_PAGES} pages`,
    });
    expect(endless).toHaveBeenCalledTimes(1 + MARKER_MAX_PAGES);
  });

  it("reads the token's account once, and fails when the list cannot be read", async () => {
    const key = token();
    const fetch = github([[]]);
    await findIssueWithMarker(MARKER, SINCE, { token: key, fetch });
    await findIssueWithMarker(MARKER, SINCE, { token: key, fetch });
    const accountReads = (fetch.mock.calls as unknown as Array<[string]>).filter(([url]) => url.endsWith("/user"));
    expect(accountReads).toHaveLength(1);

    const refused = vi.fn(async (url: string) =>
      url.endsWith("/user") ? Response.json(MONITOR) : Response.json(badCredentials, { status: 401 }),
    ) as unknown as typeof globalThis.fetch;
    await expect(findIssueWithMarker(MARKER, SINCE, { token: token(), fetch: refused })).resolves.toEqual({
      status: "failed",
      reason: "HTTP 401",
    });
  });

  it("finds only the monitor's own comment with the marker as its last line, on any page", async () => {
    const marker = "<!-- oasis-rig-alert:recovery:alert-7 -->";
    const comment = (body: string, login = MONITOR.login) => ({ ...commentCreated, body, user: { login } });
    const fullPage = Array.from({ length: 100 }, () => comment("chatter"));
    const cases: Array<[unknown[][], boolean]> = [
      [[[comment(`recovered\n\n${marker}`, "someone-else")]], false],
      [[[comment(`quoting ${marker} in passing`)]], false],
      [[fullPage, [comment(`recovered\n\n${marker}`)]], true],
    ];
    for (const [pages, expected] of cases) {
      const fetch = github(pages);
      await expect(hasCommentWithMarker(42, marker, SINCE, { token: token(), fetch })).resolves.toEqual({
        status: "sent",
        found: expected,
      });
    }
    const fetch = github([[]]);
    await hasCommentWithMarker(42, marker, SINCE, { token: token(), fetch });
    const list = new URL((fetch.mock.calls as unknown as Array<[string]>)[1]![0]);
    expect(list.pathname).toBe("/repos/codyjohnsontx/oasisRaceControl/issues/42/comments");
  });
});
