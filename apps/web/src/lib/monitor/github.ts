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
  const result = await call("/issues", { ...issue, labels: [RIG_ALERT_LABEL] }, options);
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
  const result = await call(`/issues/${number}/comments`, { body }, options);
  return result.status === "sent" ? { status: "sent" } : result;
}

/**
 * One POST. Resolves - never throws - with GitHub's JSON on a 2xx, and
 * otherwise a reason safe to log: GitHub's error body names what was wrong
 * and never echoes the token.
 */
async function call(path: string, payload: unknown, options: Options): Promise<GitHubResult<{ body: unknown }>> {
  const token = (options.token ?? process.env.GITHUB_RIG_ALERT_TOKEN)?.trim();
  if (!token) return { status: "not_configured" };

  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(`${API}${path}`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        // GitHub refuses a request without one.
        "user-agent": "oasis-rig-monitor",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? CALL_TIMEOUT_MS),
    });
    if (response.ok) return { status: "sent", body: await response.json() };
    const body = (await response.text().catch(() => "")).slice(0, 300);
    return { status: "failed", reason: `HTTP ${response.status}${body ? ` ${body}` : ""}` };
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    return { status: "failed", reason: name === "TimeoutError" ? "timed out" : `unreachable (${name})` };
  }
}
