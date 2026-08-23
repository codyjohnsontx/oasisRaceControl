import { describe, expect, it } from "vitest";
import {
  databaseTestsAreRequired,
  MissingTestDatabaseError,
  requireTestDatabase,
  safeTestDatabaseUrl,
  UnsafeTestDatabaseError,
} from "./db-guard";

/**
 * The guard is the only thing standing between the destructive integration
 * suite and a real database, so it is tested more strictly than the code it
 * protects. .env.local in this repo holds a live Neon URL, which is exactly the
 * value that must never be accepted.
 */

const LOCAL = "postgres://postgres:postgres@localhost:5433/oasis_test";

describe("safeTestDatabaseUrl", () => {
  it("accepts a local database whose name contains test", () => {
    expect(safeTestDatabaseUrl(LOCAL)).toBe(LOCAL);
  });

  it("accepts 127.0.0.1 as local", () => {
    const url = "postgres://postgres@127.0.0.1:5433/oasis_test";
    expect(safeTestDatabaseUrl(url)).toBe(url);
  });

  it("accepts IPv6 localhost, which new URL() reports bracketed", () => {
    // This exact detail has regressed twice: URL keeps the brackets, so a guard
    // comparing url.hostname against the bare "::1" refuses real localhost.
    const url = "postgres://postgres@[::1]:5433/oasis_test";
    expect(new URL(url).hostname).toBe("[::1]");
    expect(safeTestDatabaseUrl(url)).toBe(url);
  });

  it("accepts the expanded spelling of IPv6 localhost", () => {
    const url = "postgres://postgres@[0:0:0:0:0:0:0:1]:5433/oasis_test";
    expect(safeTestDatabaseUrl(url)).toBe(url);
  });

  it("still refuses a non-local IPv6 host", () => {
    expect(() => safeTestDatabaseUrl("postgres://u:p@[2001:db8::1]/oasis_test")).toThrow(
      /non-local host/,
    );
  });

  it("still refuses an IPv4-mapped address that is not loopback", () => {
    expect(() =>
      safeTestDatabaseUrl("postgres://u:p@[::ffff:203.0.113.9]/oasis_test"),
    ).toThrow(/non-local host/);
  });

  it("holds every other refusal on a bracketed IPv6 localhost URL", () => {
    expect(() => safeTestDatabaseUrl("postgres://u:p@[::1]:5433/oasis")).toThrow(
      /must contain "test"/,
    );
    expect(() =>
      safeTestDatabaseUrl("postgres://u:p@[::1]:5433/oasis_test?host=ep-x.neon.tech"),
    ).toThrow(/must not set the "host" parameter/);
    expect(() =>
      safeTestDatabaseUrl("postgres://u:p@[::1]:5433/oasis_test?some_future_option=x"),
    ).toThrow(/unrecognised parameter/);
  });

  it("treats blank values as unset so the suite skips instead of failing", () => {
    expect(safeTestDatabaseUrl("")).toBeNull();
    expect(safeTestDatabaseUrl("   ")).toBeNull();
  });

  it("reads TEST_DATABASE_URL when called with no argument", () => {
    // Must hold whether or not the caller's shell exports the variable, so the
    // env is controlled here rather than assumed.
    const saved = process.env.TEST_DATABASE_URL;
    try {
      delete process.env.TEST_DATABASE_URL;
      expect(safeTestDatabaseUrl()).toBeNull();

      process.env.TEST_DATABASE_URL = LOCAL;
      expect(safeTestDatabaseUrl()).toBe(LOCAL);
    } finally {
      if (saved === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = saved;
    }
  });

  it("refuses a Neon host even when the database is named test", () => {
    expect(() =>
      safeTestDatabaseUrl(
        "postgres://user:pw@ep-muddy-heart-ah9mspv1-pooler.c-3.us-east-1.aws.neon.tech/neondb_test",
      ),
    ).toThrow(UnsafeTestDatabaseError);
  });

  it("names the managed host in the error so the cause is obvious", () => {
    expect(() =>
      safeTestDatabaseUrl("postgres://user:pw@my-db.supabase.co/whatever_test"),
    ).toThrow(/my-db\.supabase\.co/);
  });

  it.each([
    ["supabase", "postgres://u:p@db.supabase.co/x_test"],
    ["rds", "postgres://u:p@thing.rds.amazonaws.com/x_test"],
    ["azure", "postgres://u:p@thing.postgres.azure.com/x_test"],
    ["render", "postgres://u:p@thing.render.com/x_test"],
  ])("refuses managed host: %s", (_label, url) => {
    expect(() => safeTestDatabaseUrl(url)).toThrow(UnsafeTestDatabaseError);
  });

  it("refuses any non-local host", () => {
    expect(() =>
      safeTestDatabaseUrl("postgres://u:p@db.internal.example.com/oasis_test"),
    ).toThrow(/non-local host/);
  });

  it("refuses a local database whose name does not prove it is disposable", () => {
    expect(() =>
      safeTestDatabaseUrl("postgres://postgres@localhost:5433/oasis"),
    ).toThrow(/must contain "test"/);
  });

  it("refuses the production database name outright", () => {
    expect(() =>
      safeTestDatabaseUrl("postgres://postgres@localhost:5432/neondb"),
    ).toThrow(UnsafeTestDatabaseError);
  });

  it.each([
    ["host", "postgres://u:p@localhost:5433/oasis_test?host=ep-x.neon.tech"],
    ["hostaddr", "postgres://u:p@localhost:5433/oasis_test?hostaddr=203.0.113.9"],
    ["port", "postgres://u:p@localhost:5433/oasis_test?port=6543"],
    ["dbname", "postgres://u:p@localhost:5433/oasis_test?dbname=neondb"],
    ["service", "postgres://u:p@localhost:5433/oasis_test?service=prod"],
  ])("refuses a local-looking URL that overrides routing via ?%s", (_name, url) => {
    expect(() => safeTestDatabaseUrl(url)).toThrow(UnsafeTestDatabaseError);
  });

  it("names the offending routing parameter in the error", () => {
    expect(() =>
      safeTestDatabaseUrl("postgres://u:p@localhost/oasis_test?host=ep-x.neon.tech"),
    ).toThrow(/must not set the "host" parameter/);
  });

  it("refuses unknown parameters so a new pg option cannot reopen the hole", () => {
    expect(() =>
      safeTestDatabaseUrl("postgres://u:p@localhost/oasis_test?some_future_option=x"),
    ).toThrow(/unrecognised parameter/);
  });

  it("still accepts the harmless parameters", () => {
    const url = "postgres://u:p@localhost/oasis_test?sslmode=disable";
    expect(safeTestDatabaseUrl(url)).toBe(url);
  });

  it("refuses the exact bypass that URL.hostname alone would allow", () => {
    // Verified against pg-connection-string: for this URL pg resolves the host
    // to ep-x.neon.tech while new URL().hostname reports localhost. The guard
    // must reject it on the parameter, not trust the hostname.
    const sneaky = "postgres://u:p@localhost:5433/oasis_test?host=ep-x.neon.tech";
    expect(new URL(sneaky).hostname).toBe("localhost");
    expect(() => safeTestDatabaseUrl(sneaky)).toThrow(UnsafeTestDatabaseError);
  });

  it("rejects an unparseable URL without leaking credentials", () => {
    try {
      safeTestDatabaseUrl("not a url with secret-password inside");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeTestDatabaseError);
    }
  });

  it("redacts credentials from the unparseable-URL message", () => {
    // A malformed URL still shouldn't echo a password into CI logs.
    expect(() => safeTestDatabaseUrl("://user:sup3rsecret@host/db_test")).toThrow(
      /\*\*\*@/,
    );
  });
});

/**
 * The other half of the guard: not "is this database safe to destroy" but "was
 * a database supposed to be here at all". A skipped suite and a passing suite
 * are the same exit code, so the only thing separating a CI run that proved the
 * leaderboard's SQL rules from one that proved nothing is this flag.
 */
describe("requireTestDatabase", () => {
  const LOCAL_URL = "postgres://postgres@localhost:5433/oasis_test";

  // Passed explicitly rather than set on process.env: these cases run under the
  // very flag they are about, so reading the ambient one makes them pass on a
  // developer's machine and fail in CI.
  const REQUIRED = true;
  const OPTIONAL = false;

  it("lets a developer with no Postgres skip", () => {
    expect(() => requireTestDatabase(null, "the SQL rules", OPTIONAL)).not.toThrow();
  });

  it("fails instead of skipping when CI required a database", () => {
    expect(() => requireTestDatabase(null, "the SQL rules", REQUIRED)).toThrow(
      MissingTestDatabaseError,
    );
  });

  it("names what went unproven, so a failed CI log is actionable", () => {
    expect(() =>
      requireTestDatabase(null, "league night's SQL rules", REQUIRED),
    ).toThrow(/league night's SQL rules were never exercised/);
  });

  it("says nothing when the database is there, required or not", () => {
    expect(() => requireTestDatabase(LOCAL_URL, "the SQL rules", REQUIRED)).not.toThrow();
    expect(() => requireTestDatabase(LOCAL_URL, "the SQL rules", OPTIONAL)).not.toThrow();
  });

  /**
   * The production callers take the default, so the wiring to the environment is
   * worth covering - and it is the only way to cover "unset", because passing
   * `undefined` explicitly takes the default parameter and reads the ambient
   * variable rather than overriding it.
   *
   * The previous value is restored rather than deleted: vitest can run several
   * files in one worker and CI sets this flag for the whole run, so clearing it
   * would quietly disarm the rule the next file is asserting.
   */
  function withFlag(value: string | undefined, assertion: () => void): void {
    const before = process.env.OASIS_REQUIRE_DB_TESTS;
    if (value === undefined) delete process.env.OASIS_REQUIRE_DB_TESTS;
    else process.env.OASIS_REQUIRE_DB_TESTS = value;
    try {
      assertion();
    } finally {
      if (before === undefined) delete process.env.OASIS_REQUIRE_DB_TESTS;
      else process.env.OASIS_REQUIRE_DB_TESTS = before;
    }
  }

  it("reads the environment when the caller does not say", () => {
    withFlag("1", () => {
      expect(() => requireTestDatabase(null, "the SQL rules")).toThrow(
        MissingTestDatabaseError,
      );
    });
  });

  it("skips when the environment says nothing, which is every developer machine", () => {
    withFlag(undefined, () => {
      expect(databaseTestsAreRequired()).toBe(false);
      expect(() => requireTestDatabase(null, "the SQL rules")).not.toThrow();
    });
  });

  it("treats anything but the exact opt-in as not required", () => {
    // "true", "yes" and an empty string are the values a workflow edit produces
    // by accident. Any of them silently meaning "required" would be fine; any
    // of them silently meaning "not required" would not, so the flag is exact
    // and the workflow sets the one value this accepts.
    expect(databaseTestsAreRequired("1")).toBe(true);
    for (const value of ["", "0", "true", "yes"]) {
      expect(databaseTestsAreRequired(value)).toBe(false);
    }
  });
});
