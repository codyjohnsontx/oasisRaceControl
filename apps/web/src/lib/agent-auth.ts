import { createHash } from "node:crypto";
import { queryOne } from "./db";

export type AgentRig = {
  id: string;
  rig_number: number;
  display_name: string;
  /**
   * True while a second computer is also heartbeating with this rig's token
   * (see db/migrations/0004). Judged by the database's own clock, because the
   * whole point is that two machines disagree about the time of day too.
   */
  installation_conflict: boolean;
  /** The two computers' names, for the log line and the dashboard. */
  installation_conflict_detail: string | null;
};

/**
 * How a rig's bearer token is stored, in one place. Minting a token
 * (`lib/rig-enrolment`) and authenticating one must agree exactly or a rig
 * enrolled from `/staff` would be refused by the backend that issued it, so
 * both go through this function rather than each calling sha256 themselves.
 */
export function agentTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Pure part of agent auth: Bearer token → sha256 hex, or null for missing,
 * malformed, or empty Authorization headers. */
export function bearerTokenHash(authorization: string | null): string | null {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return null;
  return agentTokenHash(token);
}

/**
 * Rig agents authenticate with a per-rig bearer token. We store the sha256 of
 * the token, so lookup is a deterministic exact match — no scan-and-compare.
 * A token can only ever act on its own rig.
 */
export async function rigFromBearer(
  authorization: string | null,
): Promise<AgentRig | null> {
  const hash = bearerTokenHash(authorization);
  if (!hash) return null;
  return queryOne<AgentRig>(
    `select id, rig_number, display_name,
            rig_installation_live(installation_conflict_at) as installation_conflict,
            installation_conflict_detail
     from rigs where agent_token_hash = $1`,
    [hash],
  );
}
