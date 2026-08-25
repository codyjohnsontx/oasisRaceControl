import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The readiness contract without a database: 200 when the pool answers, 503
 * with a plain-English reason when it does not, a body that never carries
 * what pg put in the error (pg quotes connection details in some of them),
 * and a pool client that goes back only when it is fit to be reused. What a
 * real outage looks like from outside was proven end to end when the route
 * landed (see the pull request), not here.
 */

const query = vi.fn();
const release = vi.fn();
const client = {
  query: (...args: unknown[]) => query(...args),
  release: (...args: unknown[]) => release(...args),
};
const connect = vi.fn(async () => client);
const db = vi.fn(() => ({ connect: () => connect() }));

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

/** A promise that never settles, standing in for a hung connect or query. */
const hang = () => new Promise<never>(() => {});

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  query.mockReset();
  release.mockReset();
  connect.mockReset();
  connect.mockResolvedValue(client);
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
    // Fit for reuse: back to the pool, not destroyed.
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(false);
  });

  it("still answers 200 when the migration count cannot be read", async () => {
    // A database that answers but has never been migrated: not a readiness
    // problem, a deploy-order one, and the migration gate owns that.
    databaseAnswers(pgError('relation "schema_migrations" does not exist', "42P01"));

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
    expect(release).toHaveBeenCalledWith(false);
  });

  it("answers 503 when the query does not answer within two seconds, and destroys the client", async () => {
    vi.useFakeTimers();
    query.mockReturnValue(hang());

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
    // The query is still in flight on that client; back in the pool it would
    // hold a slot until the database answered. Destroyed instead.
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(true);
  });

  it("destroys the client when the migration count is what hangs", async () => {
    vi.useFakeTimers();
    query.mockImplementation((sql: string) =>
      sql.includes("schema_migrations") ? hang() : Promise.resolve({ rows: [] }),
    );

    const pending = GET();
    await vi.advanceTimersByTimeAsync(2_000);
    const response = await pending;

    expect(response.status).toBe(503);
    expect(release).toHaveBeenCalledWith(true);
  });

  it("answers 503 when no client can be acquired in time, and returns the late one", async () => {
    vi.useFakeTimers();
    let arrive: (value: typeof client) => void = () => {};
    connect.mockReturnValue(new Promise((resolve) => (arrive = resolve)));

    const pending = GET();
    await vi.advanceTimersByTimeAsync(2_000);
    const response = await pending;

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "unavailable",
      reason: "database did not answer within 2000ms",
    });
    expect(query).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();

    // The connect finishes after all: nobody is waiting, so the client goes
    // straight back rather than leaking a slot.
    vi.useRealTimers();
    arrive(client);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith();
  });

  it("answers 503 with a plain-English reason when the connect fails", async () => {
    connect.mockRejectedValue(
      pgError('password authentication failed for user "probe"', "28P01"),
    );

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "unavailable",
      reason: "database connection or query failed (28P01)",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[ready] database probe failed",
      'password authentication failed for user "probe"',
    );
    expect(release).not.toHaveBeenCalled();
  });

  it("answers 503 and destroys the client when the query itself fails", async () => {
    query.mockRejectedValue(
      pgError("terminating connection due to administrator command", "57P01"),
    );

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "unavailable",
      reason: "database connection or query failed (57P01)",
    });
    expect(release).toHaveBeenCalledWith(true);
  });

  it("names the refused addresses in the log when the database is down", async () => {
    // The shape Node hands pg for a refused localhost connection: an
    // AggregateError with the code but an empty message of its own.
    const refused = new AggregateError([
      pgError("connect ECONNREFUSED ::1:5432"),
      pgError("connect ECONNREFUSED 127.0.0.1:5432"),
    ]);
    (refused as AggregateError & { code: string }).code = "ECONNREFUSED";
    connect.mockRejectedValue(refused);

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
    // Every 503 leaves the same tagged line, so the log explains this one too.
    expect(consoleError).toHaveBeenCalledWith(
      "[ready] database probe failed",
      "DATABASE_URL is not set",
    );
  });

  it("never puts the connection string or a stack trace in the body", async () => {
    // No pg code on this one, so there is nothing to quote but the message -
    // and the message is exactly what must not reach the body.
    connect.mockRejectedValue(pgError(`password authentication failed for ${DATABASE_URL}`));

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
