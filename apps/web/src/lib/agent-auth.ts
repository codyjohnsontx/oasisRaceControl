import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export type AgentRig = {
  id: string;
  rig_number: number;
  display_name: string;
};

/**
 * Rig agents authenticate with a per-rig bearer token. We store the sha256 of
 * the token, so lookup is a deterministic exact match — no scan-and-compare.
 * A token can only ever act on its own rig.
 */
export async function rigFromBearer(
  db: SupabaseClient,
  authorization: string | null,
): Promise<AgentRig | null> {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return null;

  const hash = createHash("sha256").update(token).digest("hex");
  const { data } = await db
    .from("rigs")
    .select("id, rig_number, display_name")
    .eq("agent_token_hash", hash)
    .maybeSingle();

  return data ?? null;
}
