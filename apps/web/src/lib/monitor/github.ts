import { REPOSITORY } from "./handoff";

/**
 * The rig-alert issue's transport (plan section 11, owner decision R5): an
 * urgent alert whose cause may be software is filed as a GitHub issue on this
 * repository, labelled rig-alert, which firstmate watches and hands to a fix
 * worker. The owner still approves every merge.
 *
 * The token comes only from GITHUB_RIG_ALERT_TOKEN, a fine-grained personal
 * access token scoped to this one repository with Issues read and write and
 * nothing else, and is never written to the repository, a log line or an
 * error. A deployment without it files nothing and the Discord handoff stays
 * the whole story - so no preview or laptop can open an issue.
 */

export const RIG_ALERT_LABEL = "rig-alert";

const API = `https://api.github.com/repos/${REPOSITORY}`;

/** How long a call may take before it counts as failed and is retried later. */
const CALL_TIMEOUT_MS = 10_000;

export type GitHubResult<T = object> =
  | ({ status: "sent" } & T)
  | { status: "not_configured" }
  | { status: "failed"; reason: string };

export function githubConfigured(token = process.env.GITHUB_RIG_ALERT_TOKEN): boolean {
  return Boolean(token?.trim());
}

type Options = { token?: string; fetch?: typeof fetch; timeoutMs?: number };

/**
 * Opens an issue labelled rig-alert. `labelled` is false when GitHub filed it
 * without the label - it drops labels silently when the token may not set
 * them - since an unlabelled issue is never picked up.
 */
export async function openIssue(
  issue: { title: string; body: string },
  options: Options = {},
): Promise<GitHubResult<{ number: number; labelled: boolean }>> {
  const result = await call("POST", "/issues", { ...issue, labels: [RIG_ALERT_LABEL] }, options);
  if (result.status !== "sent") return result;
  const answer = result.body as { number?: unknown; labels?: Array<{ name?: unknown }> };
  if (typeof answer.number !== "number") return { status: "failed", reason: "no issue number in the answer" };
  return {
    status: "sent",
    number: answer.number,
    labelled: (answer.labels ?? []).some((label) => label.name === RIG_ALERT_LABEL),
  };
}

export async function commentOnIssue(number: number, body: string, options: Options = {}): Promise<GitHubResult> {
  const result = await call("POST", `/issues/${number}/comments`, { body }, options);
  return result.status === "sent" ? { status: "sent" } : result;
}

/**
 * Reopens the numbered issue if it has been closed, so a re-fire after a fix
 * that did not hold is picked up again; an open issue is left alone.
 */
export async function reopenIssue(number: number, options: Options = {}): Promise<GitHubResult> {
  const found = await call("GET", `/issues/${number}`, undefined, options);
  if (found.status !== "sent") return found;
  if ((found.body as { state?: unknown }).state !== "closed") return { status: "sent" };
  const reopened = await call("PATCH", `/issues/${number}`, { state: "open" }, options);
  return reopened.status === "sent" ? { status: "sent" } : reopened;
}

/**
 * The issue that carries `marker`, if one was filed. Reads the repository's
 * issues updated since `since` (the list, not search, which lags behind
 * writes), newest first; the monitor files a handful a day, so the first page
 * of 100 reaches back past any retry window.
 */
export async function findIssueWithMarker(
  marker: string,
  since: number,
  options: Options = {},
): Promise<GitHubResult<{ number: number | null }>> {
  const query = `state=all&sort=created&direction=desc&per_page=100&since=${new Date(since).toISOString()}`;
  const result = await call("GET", `/issues?${query}`, undefined, options);
  if (result.status !== "sent") return result;
  const issues = Array.isArray(result.body) ? (result.body as Array<{ number?: unknown; body?: unknown; pull_request?: unknown }>) : [];
  const found = issues.find(
    (issue) => !issue.pull_request && typeof issue.body === "string" && issue.body.includes(marker),
  );
  return { status: "sent", number: typeof found?.number === "number" ? found.number : null };
}

/** Whether a comment carrying `marker` is already on the numbered issue. */
export async function hasCommentWithMarker(
  number: number,
  marker: string,
  since: number,
  options: Options = {},
): Promise<GitHubResult<{ found: boolean }>> {
  const query = `per_page=100&since=${new Date(since).toISOString()}`;
  const result = await call("GET", `/issues/${number}/comments?${query}`, undefined, options);
  if (result.status !== "sent") return result;
  const comments = Array.isArray(result.body) ? (result.body as Array<{ body?: unknown }>) : [];
  return {
    status: "sent",
    found: comments.some((comment) => typeof comment.body === "string" && comment.body.includes(marker)),
  };
}

/**
 * One request. Resolves - never throws - with GitHub's JSON on a 2xx, and
 * otherwise a reason made only of the status code: an error body is never
 * read, because nothing guarantees it cannot echo the token or the issue.
 */
async function call(
  method: "GET" | "POST" | "PATCH",
  path: string,
  payload: unknown,
  options: Options,
): Promise<GitHubResult<{ body: unknown }>> {
  const token = (options.token ?? process.env.GITHUB_RIG_ALERT_TOKEN)?.trim();
  if (!token) return { status: "not_configured" };

  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(`${API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        // GitHub refuses a request without one.
        "user-agent": "oasis-rig-monitor",
        "x-github-api-version": "2022-11-28",
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? CALL_TIMEOUT_MS),
    });
    if (response.ok) return { status: "sent", body: await response.json() };
    await response.body?.cancel().catch(() => {});
    return { status: "failed", reason: `HTTP ${response.status}` };
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    return { status: "failed", reason: name === "TimeoutError" ? "timed out" : `unreachable (${name})` };
  }
}
