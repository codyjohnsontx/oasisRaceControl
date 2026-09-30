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
 * the whole story - so no preview or laptop can open an issue. Besides the
 * issue calls it reads GET /user, which needs no permission, to learn whose
 * writes the marker lookups may trust.
 */

export const RIG_ALERT_LABEL = "rig-alert";

const API = "https://api.github.com";
const REPO = `/repos/${REPOSITORY}`;

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
  const result = await call("POST", `${REPO}/issues`, { ...issue, labels: [RIG_ALERT_LABEL] }, options);
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
  const result = await call("POST", `${REPO}/issues/${number}/comments`, { body }, options);
  return result.status === "sent" ? { status: "sent" } : result;
}

/**
 * Reopens the numbered issue if it has been closed, so a re-fire after a fix
 * that did not hold is picked up again; an open issue is left alone.
 */
export async function reopenIssue(number: number, options: Options = {}): Promise<GitHubResult> {
  const found = await call("GET", `${REPO}/issues/${number}`, undefined, options);
  if (found.status !== "sent") return found;
  if ((found.body as { state?: unknown }).state !== "closed") return { status: "sent" };
  const reopened = await call("PATCH", `${REPO}/issues/${number}`, { state: "open" }, options);
  return reopened.status === "sent" ? { status: "sent" } : reopened;
}

/** Pages of 100 a marker lookup reads at most before giving up (and retrying later). */
export const MARKER_MAX_PAGES = 10;
const PAGE_SIZE = 100;

type Authored = { body?: unknown; user?: { login?: unknown } | null };

/**
 * The marker `item` carries when it is the monitor's own write: its body's
 * exact last line, when the token's account wrote it. Anyone can open an
 * issue or comment on this public repository and type a marker, and a handoff
 * can quote one mid-text; neither counts.
 */
function markerOf(item: Authored, login: string): string | null {
  if (item.user?.login !== login || typeof item.body !== "string") return null;
  return item.body.trimEnd().split("\n").at(-1) ?? null;
}

/**
 * The GitHub account the token belongs to - whose writes the marker lookups
 * trust - read once per token and kept for the life of the process.
 */
let accountFor: { token: string; login: string } | null = null;

async function monitorAccount(options: Options): Promise<GitHubResult<{ login: string }>> {
  const token = (options.token ?? process.env.GITHUB_RIG_ALERT_TOKEN)?.trim();
  if (!token) return { status: "not_configured" };
  if (accountFor?.token === token) return { status: "sent", login: accountFor.login };
  const result = await call("GET", "/user", undefined, options);
  if (result.status !== "sent") return result;
  const login = (result.body as { login?: unknown }).login;
  if (typeof login !== "string" || !login) return { status: "failed", reason: "no login in the answer" };
  accountFor = { token, login };
  return { status: "sent", login };
}

/**
 * Reads a list endpoint page by page until `enough` says a page settles it, a
 * short page ends the list, or MARKER_MAX_PAGES have been read - which fails,
 * so the write is retried later rather than repeated on a guess.
 */
async function readPages<T>(
  path: string,
  query: string,
  enough: (page: T[]) => boolean,
  options: Options,
): Promise<GitHubResult<{ items: T[] }>> {
  const items: T[] = [];
  for (let page = 1; page <= MARKER_MAX_PAGES; page++) {
    const result = await call("GET", `${path}?${query}&per_page=${PAGE_SIZE}&page=${page}`, undefined, options);
    if (result.status !== "sent") return result;
    const read = Array.isArray(result.body) ? (result.body as T[]) : [];
    items.push(...read);
    if (enough(read) || read.length < PAGE_SIZE) return { status: "sent", items };
  }
  return { status: "failed", reason: `marker not found in ${MARKER_MAX_PAGES} pages` };
}

/**
 * The issue the monitor filed, created since `since`, whose marker `match`
 * accepts - with that marker and whether it has the rig-alert label. Reads
 * the repository's issues updated since then - the list, not search, which
 * lags behind writes.
 */
export async function findIssueWithMarker(
  match: (marker: string) => boolean,
  since: number,
  options: Options = {},
): Promise<GitHubResult<{ number: number | null; marker: string | null; labelled: boolean }>> {
  const account = await monitorAccount(options);
  if (account.status !== "sent") return account;
  type Issue = Authored & {
    number?: unknown;
    created_at?: unknown;
    pull_request?: unknown;
    labels?: Array<{ name?: unknown }>;
  };
  const isIt = (issue: Issue) => {
    const marker = markerOf(issue, account.login);
    return (
      !issue.pull_request &&
      typeof issue.number === "number" &&
      typeof issue.created_at === "string" &&
      Date.parse(issue.created_at) >= since &&
      marker !== null &&
      match(marker)
    );
  };
  const read = await readPages<Issue>(
    `${REPO}/issues`,
    `state=all&sort=created&direction=desc&since=${new Date(since).toISOString()}`,
    (page) => page.some(isIt),
    options,
  );
  if (read.status !== "sent") return read;
  const issue = read.items.find(isIt);
  return {
    status: "sent",
    number: (issue?.number as number | undefined) ?? null,
    marker: issue ? markerOf(issue, account.login) : null,
    labelled: (issue?.labels ?? []).some((label) => label.name === RIG_ALERT_LABEL),
  };
}

/** The markers of every comment the monitor left on the numbered issue since `since`. */
export async function commentMarkers(
  number: number,
  since: number,
  options: Options = {},
): Promise<GitHubResult<{ markers: string[] }>> {
  const account = await monitorAccount(options);
  if (account.status !== "sent") return account;
  const read = await readPages<Authored>(
    `${REPO}/issues/${number}/comments`,
    `since=${new Date(since).toISOString()}`,
    () => false,
    options,
  );
  if (read.status !== "sent") return read;
  const markers = read.items.map((comment) => markerOf(comment, account.login));
  return { status: "sent", markers: markers.filter((marker): marker is string => marker !== null) };
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
