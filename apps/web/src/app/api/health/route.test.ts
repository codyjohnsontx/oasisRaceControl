import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Liveness must not depend on anything outside the process. The pool module
 * is mocked to throw if touched and DATABASE_URL is unset, so a handler that
 * reached for the database would fail this either way.
 */

const db = vi.fn(() => {
  throw new Error("liveness must not touch the pool");
});

vi.mock("@/lib/db", () => ({
  db: () => db(),
  query: () => db(),
  queryOne: () => db(),
}));

const { GET } = await import("./route");

beforeEach(() => {
  db.mockClear();
  delete process.env.DATABASE_URL;
});

describe("GET /api/health", () => {
  it("answers 200 without the database or any configuration", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
    expect(db).not.toHaveBeenCalled();
  });
});
