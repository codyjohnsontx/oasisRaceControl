import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The readiness contract without a database: 200 when the pool answers, 503
 * with a plain-English reason when it does not, and a body that never carries
 * what pg put in the error, because pg quotes connection details in some of
 * them. What a real outage looks like from outside was proven end to end when
 * the route landed (see the pull request), not here.
 */

const query = vi.fn();
const db = vi.fn(() => ({ query: (...args: unknown[]) => query(...args) }));

vi.mock("@/lib/db", () => ({
  db: () => db(),
}));

const { GET } = await import("./route");

const SECRET = "hunter2-do-not-leak";
const DATABASE_URL = `postgres://probe:${SECRET}@db.internal:5432/oasis`;

/** `select 1` answers; the migration count answers `applied`, or throws it. */
function databaseAnswers(applied: number | Error = 3) {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("schema_migrations")) {
      if (applied instanceof Error) throw applied;
      return { rows: [{ applied }] };
    }
    return { rows: [{ "?column?": 1 }] };
  });
}

function pgError(message: string, code?: string): Error {
  const error = new Error(message);
  if (code) (error as Error & { code: string }).code = code;
  return error;
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  query.mockReset();
  db.mockClear();
  process.env.DATABASE_URL = DATABASE_URL;
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  consoleError.mockRestore();
});

describe("GET /api/ready", () => {
  it("answers 200 with the applied-migration count when the database answers", async () => {
    databaseAnswers(3);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok", appliedMigrations: 3 });
    expect(query).toHaveBeenNthCalledWith(1, "select 1");
  });

  it("still answers 200 when the migration count cannot be read", async () => {
    // A database that answers but has never been migrated: not a readiness
    // problem, a deploy-order one, and the migration gate owns that.
    databaseAnswers(pgError('relation "schema_migrations" does not exist', "42P01"));

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("answers 503 when the database does not answer within two seconds", async () => {
    vi.useFakeTimers();
    query.mockReturnValue(new Promise(() => {}));

    let settled = false;
    const pending = GET().then((response) => {
      settled = true;
      return response;
    });

    // It waits for the database rather than giving up early...
    await vi.advanceTimersByTimeAsync(1_500);
    expect(settled).toBe(false);

    // ...and gives up at the deadline, not whenever pg gets round to it.
    await vi.advanceTimersByTimeAsync(500);
    const response = await pending;

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "unavailable",
      reason: "database did not answer within 2000ms",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[ready] database probe failed",
      "database did not answer within 2000ms",
    );
  });

  it("answers 503 with a plain-English reason when the query fails", async () => {
    query.mockRejectedValue(pgError("password authentication failed for user \"probe\"", "28P01"));

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "unavailable",
      reason: "database connection or query failed (28P01)",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[ready] database probe failed",
      "password authentication failed for user \"probe\"",
    );
  });

  it("names the refused addresses in the log when the database is down", async () => {
    // The shape Node hands pg for a refused localhost connection: an
    // AggregateError with the code but an empty message of its own.
    const refused = new AggregateError(
      [pgError("connect ECONNREFUSED ::1:5432"), pgError("connect ECONNREFUSED 127.0.0.1:5432")],
    );
    (refused as AggregateError & { code: string }).code = "ECONNREFUSED";
    query.mockRejectedValue(refused);

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "unavailable",
      reason: "database connection or query failed (ECONNREFUSED)",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[ready] database probe failed",
      "connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432",
    );
  });

  it("answers 503 when DATABASE_URL is not set, without touching the pool", async () => {
    delete process.env.DATABASE_URL;

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "unavailable",
      reason: "DATABASE_URL is not set",
    });
    expect(db).not.toHaveBeenCalled();
  });

  it("never puts the connection string or a stack trace in the body", async () => {
    // No pg code on this one, so there is nothing to quote but the message -
    // and the message is exactly what must not reach the body.
    query.mockRejectedValue(pgError(`password authentication failed for ${DATABASE_URL}`));

    const response = await GET();
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain("db.internal");
    expect(JSON.parse(body)).toEqual({
      status: "unavailable",
      reason: "database connection or query failed",
    });
  });
});
