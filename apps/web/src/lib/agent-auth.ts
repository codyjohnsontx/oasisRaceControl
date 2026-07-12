import { createHash } from "node:crypto";
import { queryOne } from "./db";

export type AgentRig = {
  id: string;
  rig_number: number;
  display_name: string;
};

/** Pure part of agent auth: Bearer token → sha256 hex, or null for missing,
 * malformed, or empty Authorization headers. */
export function bearerTokenHash(authorization: string | null): string | null {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return null;
  return createHash("sha256").update(token).digest("hex");
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
    "select id, rig_number, display_name from rigs where agent_token_hash = $1",
    [hash],
  );
}
