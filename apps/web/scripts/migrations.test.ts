import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appliedMigrations,
  migrationFiles,
  pendingMigrations,
  unknownApplied,
} from "./migrations";

/**
 * The bookkeeping behind `npm run db:check`. A wrong answer here is worse than
 * no gate at all: "all applied" against a database that is behind is exactly
 * the silence that let /league and /staff ship broken in the first place.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

/** A pg Client stand-in: answers each query by matching the SQL it is given. */
function fakeClient(answers: Array<[RegExp, Record<string, unknown>[]]>) {
  return {
    async query<Row extends Record<string, unknown>>(text: string) {
      const match = answers.find(([pattern]) => pattern.test(text));
      if (!match) throw new Error(`unexpected query: ${text}`);
      return { rows: match[1] as Row[] };
    },
  };
}

describe("migrationFiles", () => {
  it("lists the repository's own migrations in apply order", () => {
    const files = migrationFiles(MIGRATIONS_DIR);

    expect(files[0]).toBe("0001_core_schema.sql");
    expect(files).toContain("0002_league_night.sql");
    expect(files).toStrictEqual([...files].sort());
    expect(files.every((file) => file.endsWith(".sql"))).toBe(true);
  });
});

describe("appliedMigrations", () => {
  it("reads the recorded versions", async () => {
    const client = fakeClient([
      [/to_regclass/, [{ name: "schema_migrations" }]],
      [/select version/, [{ version: "0001_core_schema.sql" }, { version: "0002_league_night.sql" }]],
    ]);

    expect(await appliedMigrations(client)).toStrictEqual(
      new Set(["0001_core_schema.sql", "0002_league_night.sql"]),
    );
  });

  it("treats a database with no schema_migrations table as migration zero", async () => {
    // And must not go on to select from it - a 42P01 here would be reported as
    // a broken gate rather than as a database nobody has ever migrated.
    const client = fakeClient([[/to_regclass/, [{ name: null }]]]);

    expect(await appliedMigrations(client)).toStrictEqual(new Set());
  });
});

describe("pendingMigrations", () => {
  const files = ["0001_a.sql", "0002_b.sql", "0003_c.sql"];

  it("is empty when the database is current", () => {
    expect(pendingMigrations(files, new Set(files))).toStrictEqual([]);
  });

  it("reports what is missing, still in apply order", () => {
    // The production outage's exact shape: the code carries 0002, the database
    // stopped at 0001.
    expect(pendingMigrations(files, new Set(["0001_a.sql"]))).toStrictEqual([
      "0002_b.sql",
      "0003_c.sql",
    ]);
  });

  it("reports a gap in the middle rather than only the newest file", () => {
    expect(pendingMigrations(files, new Set(["0001_a.sql", "0003_c.sql"]))).toStrictEqual([
      "0002_b.sql",
    ]);
  });
});

describe("unknownApplied", () => {
  it("is empty when every recorded version has a file", () => {
    expect(unknownApplied(["0001_a.sql"], new Set(["0001_a.sql"]))).toStrictEqual([]);
  });

  it("names versions the checkout cannot explain", () => {
    // A database ahead of the code: a rollback deploy, or a renamed migration.
    expect(
      unknownApplied(["0001_a.sql"], new Set(["0001_a.sql", "0002_gone.sql"])),
    ).toStrictEqual(["0002_gone.sql"]);
  });
});
