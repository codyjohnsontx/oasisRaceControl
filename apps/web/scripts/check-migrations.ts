/**
 * Deploy gate: refuses to build when the database is behind db/migrations.
 *
 * This exists because the opposite order shipped once. League night's code
 * went to Vercel while 0002_league_night.sql had never been applied to the
 * production Neon database, so /league and /staff returned HTTP 500 until
 * someone probed the site by hand. Vercel does not run migrations on deploy -
 * deliberately, see docs/deploy.md - so nothing else enforced "migrate first,
 * then deploy".
 *
 * Failing the build is the point: the deploy is rejected and the previous
 * deployment, which matches the database, stays live. A site that keeps
 * working beats a site that ships and 500s.
 *
 * READ ONLY. It never creates schema_migrations and never applies anything;
 * applying stays scripts/migrate.ts, run by a human against a named database.
 *
 * Usage: npm run db:check   (also runs as the first half of `npm run build`)
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { config } from "dotenv";
import {
  appliedMigrations,
  migrationFiles,
  pendingMigrations,
  unknownApplied,
} from "./migrations";

config({ path: [".env.local", ".env"], quiet: true });

const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "db", "migrations");

/** Long enough for a cold Neon compute to wake, short enough to fail a hung
 *  build with a readable error instead of the platform's timeout. */
const CONNECT_TIMEOUT_MS = 15_000;

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/**
 * A readable one-liner for a thrown error. Node's happy-eyeballs dialer
 * rejects a refused connection with an AggregateError whose own `message` is
 * empty, so printing that verbatim would report "cannot reach the database:"
 * and nothing else - exactly when the reason matters most.
 */
function describeError(error: unknown): string {
  const err = error as { message?: string; code?: string; errors?: unknown[] };
  if (err?.message) return err.message;

  const attempts = Array.isArray(err?.errors)
    ? err.errors.map((inner) => (inner as Error)?.message).filter(Boolean)
    : [];
  if (attempts.length) return `${err.code ?? "connection failed"}: ${attempts.join("; ")}`;

  return err?.code ?? String(error);
}

async function main() {
  if (process.env.SKIP_MIGRATION_CHECK) {
    console.warn(
      "! migration check skipped by SKIP_MIGRATION_CHECK - this build may need a schema the database does not have",
    );
    return;
  }

  // db/migrations sits outside apps/web, which is Vercel's Root Directory. It
  // is there because "Include files outside of the Root Directory in the Build
  // Step" is on by default - but if it is ever turned off, this gate would have
  // nothing to compare against, and a gate that quietly disables itself is
  // worse than none. Fail, and name the setting.
  if (!existsSync(MIGRATIONS_DIR)) {
    fail(
      `cannot find db/migrations at ${MIGRATIONS_DIR}\n` +
        `  On Vercel this means the build cannot see files outside the Root Directory:\n` +
        `  Settings -> General -> Root Directory -> "Include files outside of the Root Directory\n` +
        `  in the Build Step" must stay enabled.`,
    );
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    // A build with no database configured cannot be a deploy of a working app;
    // every route throws on the first query regardless. Blocking it would only
    // stop contributors building the app without Postgres running.
    console.log("migration check skipped: DATABASE_URL is not set");
    return;
  }

  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });

  try {
    await client.connect();
  } catch (error) {
    fail(
      `cannot reach the database to verify its schema: ${describeError(error)}\n` +
        `  DATABASE_URL is set, so this build is meant for a real database and cannot be checked.\n` +
        `  Fix the connection, or override with SKIP_MIGRATION_CHECK=1 if you know the schema is current.`,
    );
  }

  let files: string[];
  let applied: Set<string>;
  try {
    files = migrationFiles(MIGRATIONS_DIR);
    applied = await appliedMigrations(client);
  } finally {
    await client.end();
  }

  const pending = pendingMigrations(files, applied);
  const unknown = unknownApplied(files, applied);

  if (unknown.length) {
    // Not fatal: a deliberate rollback deploys code older than the database,
    // and blocking that would be worse than the confusion it prevents.
    console.warn(
      `! the database has recorded ${unknown.length} migration(s) this checkout does not contain: ${unknown.join(", ")}`,
    );
  }

  if (pending.length) {
    fail(
      `the database is behind db/migrations - ${pending.length} migration(s) not applied:\n` +
        pending.map((file) => `      ${file}`).join("\n") +
        `\n\n  Apply them to that same database first, then deploy:\n` +
        `      cd apps/web && npm run db:migrate\n\n` +
        `  Deploying this build would return HTTP 500 from every route that needs the missing schema.\n` +
        `  Override with SKIP_MIGRATION_CHECK=1 only if you know why.`,
    );
  }

  console.log(
    `migration check ok: ${files.length} migration(s) in db/migrations, all applied`,
  );
}

main().catch((error) => {
  fail(`migration check failed: ${describeError(error)}`);
});
