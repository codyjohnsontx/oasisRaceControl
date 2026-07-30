import { describe, expect, it } from "vitest";
import { safeTestDatabaseUrl, UnsafeTestDatabaseError } from "./db-guard";

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
