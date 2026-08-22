import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appliedMigrations,
  describeTarget,
  gateMode,
  migrationFiles,
  pendingMigrations,
  skipRequested,
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

describe("gateMode", () => {
  // The four bad states share one decision, so what matters here is only where
  // the build runs and whether a database was configured at all. "behind"
  // stands in for every state the gate can reach with a DATABASE_URL set.
  const behind = { DATABASE_URL: "postgres://x/y" };

  it("fails a production build with no DATABASE_URL", () => {
    expect(gateMode({ VERCEL: "1", VERCEL_ENV: "production" })).toBe("fail");
  });

  it("fails a production build against a database that is behind", () => {
    expect(gateMode({ VERCEL: "1", VERCEL_ENV: "production", ...behind })).toBe("fail");
  });

  it("only warns on a preview build with no DATABASE_URL", () => {
    // Which is the ordinary case: a DATABASE_URL scoped to Production only is
    // not present in a preview build at all.
    expect(gateMode({ VERCEL: "1", VERCEL_ENV: "preview" })).toBe("warn");
  });

  it("only warns on a preview build against a database that is behind", () => {
    // The pull request that adds a migration is exactly the one whose preview
    // has to stay reviewable.
    expect(gateMode({ VERCEL: "1", VERCEL_ENV: "preview", ...behind })).toBe("warn");
  });

  it("warns on a Vercel build that names no environment", () => {
    expect(gateMode({ VERCEL: "1" })).toBe("warn");
  });

  it("skips a local build with no DATABASE_URL", () => {
    expect(gateMode({})).toBe("skip");
  });

  it("fails a local build against a database that is behind", () => {
    // A developer who configured a database gets told to run db:migrate.
    expect(gateMode(behind)).toBe("fail");
  });
});

describe("skipRequested", () => {
  it("turns the gate off only for the documented values", () => {
    for (const value of ["1", "true", "TRUE", " true "]) {
      expect(skipRequested(value)).toBe(true);
    }
  });

  it("leaves the gate on for anything else", () => {
    // "0" and "false" most of all: someone writing those means "run the
    // check", and reading them as "skip" inverts the intent.
    for (const value of [undefined, "", "  ", "0", "false", "no", "yes"]) {
      expect(skipRequested(value)).toBe(false);
    }
  });
});

describe("describeTarget", () => {
  it("names host and database without the credentials", () => {
    const target = describeTarget(
      "postgresql://oasis:hunter2@ep-cool-1-pooler.us-east-2.aws.neon.tech/oasis?sslmode=require",
    );

    expect(target).toBe("ep-cool-1-pooler.us-east-2.aws.neon.tech/oasis");
    expect(target).not.toContain("hunter2");
  });

  it("keeps the port, which is what tells local Docker apart from Neon", () => {
    expect(describeTarget("postgres://oasis:oasis@localhost:5433/oasis")).toBe(
      "localhost:5433/oasis",
    );
  });

  it("says so rather than throwing when the value is not a URL", () => {
    // Printing the target must never be the thing that breaks the run.
    expect(describeTarget("not a url")).toBe("(unparseable DATABASE_URL)");
  });
});
