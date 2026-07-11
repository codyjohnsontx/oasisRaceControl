import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { rigFromBearer } from "./agent-auth";

const RIG = { id: "rig-uuid", rig_number: 1, display_name: "Rig 01" };

/** Minimal mock of the .from().select().eq().maybeSingle() chain that also
 * captures what the lookup was filtered on. */
function mockDb(row: typeof RIG | null, capture?: { column?: string; value?: string }) {
  return {
    from: () => ({
      select: () => ({
        eq: (column: string, value: string) => {
          if (capture) {
            capture.column = column;
            capture.value = value;
          }
          return { maybeSingle: async () => ({ data: row }) };
        },
      }),
    }),
  } as unknown as SupabaseClient;
}

describe("rigFromBearer", () => {
  it("rejects a missing Authorization header", async () => {
    expect(await rigFromBearer(mockDb(RIG), null)).toBeNull();
  });

  it("rejects non-Bearer schemes and empty tokens", async () => {
    expect(await rigFromBearer(mockDb(RIG), "Basic abc123")).toBeNull();
    expect(await rigFromBearer(mockDb(RIG), "Bearer ")).toBeNull();
    expect(await rigFromBearer(mockDb(RIG), "Bearer")).toBeNull();
  });

  it("returns null when no rig matches the token hash", async () => {
    expect(await rigFromBearer(mockDb(null), "Bearer wrong-token")).toBeNull();
  });

  it("looks up by the sha256 of the token and returns the rig", async () => {
    const capture: { column?: string; value?: string } = {};
    const rig = await rigFromBearer(mockDb(RIG, capture), "Bearer dev-rig-1-secret");

    expect(rig).toEqual(RIG);
    expect(capture.column).toBe("agent_token_hash");
    expect(capture.value).toBe(
      createHash("sha256").update("dev-rig-1-secret").digest("hex"),
    );
  });

  it("tolerates surrounding whitespace in the token", async () => {
    const capture: { column?: string; value?: string } = {};
    await rigFromBearer(mockDb(RIG, capture), "Bearer   dev-rig-1-secret  ");
    expect(capture.value).toBe(
      createHash("sha256").update("dev-rig-1-secret").digest("hex"),
    );
  });
});
