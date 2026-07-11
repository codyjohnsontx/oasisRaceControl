import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bearerTokenHash } from "./agent-auth";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe("bearerTokenHash", () => {
  it("rejects a missing Authorization header", () => {
    expect(bearerTokenHash(null)).toBeNull();
  });

  it("rejects non-Bearer schemes and empty tokens", () => {
    expect(bearerTokenHash("Basic abc123")).toBeNull();
    expect(bearerTokenHash("Bearer ")).toBeNull();
    expect(bearerTokenHash("Bearer")).toBeNull();
    expect(bearerTokenHash("")).toBeNull();
  });

  it("hashes the token with sha256 for deterministic lookup", () => {
    expect(bearerTokenHash("Bearer dev-rig-1-secret")).toBe(sha256("dev-rig-1-secret"));
  });

  it("is case-insensitive on the scheme and trims whitespace", () => {
    expect(bearerTokenHash("bearer dev-rig-1-secret")).toBe(sha256("dev-rig-1-secret"));
    expect(bearerTokenHash("Bearer   dev-rig-1-secret  ")).toBe(sha256("dev-rig-1-secret"));
  });

  it("different tokens produce different hashes", () => {
    expect(bearerTokenHash("Bearer a")).not.toBe(bearerTokenHash("Bearer b"));
  });
});
