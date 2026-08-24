/**
 * Deploy gate: refuses to build production when the database is behind
 * db/migrations.
 *
 * This exists because the opposite order shipped once. League night's code
 * went to Vercel while 0002_league_night.sql had never been applied to the
 * production Neon database, so /league and /staff returned HTTP 500 until
 * someone probed the site by hand. Vercel does not run migrations on deploy -
 * deliberately, see docs/deploy.md - so nothing else enforced "migrate first,
 * then deploy".
 *
 * Failing the production build is the point: the deploy is rejected and the
 * previous deployment, which matches the database, stays live. A site that
 * keeps working beats a site that ships and 500s.
 *
 * How hard it is about a database it cannot verify depends on where the build
 * runs - production refuses, a preview warns, a local build without a database
 * skips. That decision is gateMode() in ./migrations, which documents why.
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
  describeError,
  describeTarget,
  gateMode,
  migrationFiles,
  pendingMigrations,
  skipRequested,
  unknownApplied,
  type GateMode,
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
 * Reports a state the gate could not verify, at the severity this build
 * environment calls for. It returns when the environment only warns, and there
 * is never anything left to check after one of these, so every caller stops.
 */
function report(mode: GateMode, message: string): void {
  if (mode === "fail") fail(message);
  console.warn(`\n! ${message}\n`);
}

async function main() {
  const skipFlag = process.env.SKIP_MIGRATION_CHECK;
  if (skipRequested(skipFlag)) {
    console.warn(
      "! migration check skipped by SKIP_MIGRATION_CHECK - this build may need a schema the database does not have",
    );
    return;
  }
  if (skipFlag?.trim()) {
    console.warn(
      `! SKIP_MIGRATION_CHECK=${skipFlag} ignored - only "1" or "true" turns the gate off, so it stays on`,
    );
  }

  const mode = gateMode(process.env);
  if (mode === "skip") {
    console.log("migration check skipped: DATABASE_URL is not set");
    return;
  }

  // db/migrations sits outside apps/web, which is Vercel's Root Directory. It
  // is there because "Include files outside of the Root Directory in the Build
  // Step" is on by default - but if it is ever turned off, this gate would have
  // nothing to compare against, and a gate that quietly disables itself is
  // worse than none. Say so, and name the setting.
  if (!existsSync(MIGRATIONS_DIR)) {
    report(
      mode,
      `cannot find db/migrations at ${MIGRATIONS_DIR}\n` +
        `  On Vercel this means the build cannot see files outside the Root Directory:\n` +
        `  Settings -> General -> Root Directory -> "Include files outside of the Root Directory\n` +
        `  in the Build Step" must stay enabled.`,
    );
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    report(
      mode,
      `DATABASE_URL is not set, so this build's database cannot be checked at all.\n` +
        `  On Vercel, set it for the environment being built:\n` +
        `  Settings -> Environment Variables. One scoped to Production only is absent\n` +
        `  from every preview build.`,
    );
    return;
  }

  // Which database, before anything else, so nobody has to infer it from
  // .env.local - an exported DATABASE_URL wins over that file silently.
  const target = describeTarget(url);
  console.log(`migration check target: ${target}`);

  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });

  try {
    await client.connect();
  } catch (error) {
    report(
      mode,
      `cannot reach ${target} to verify its schema: ${describeError(error)}\n` +
        `  DATABASE_URL is set, so this build is meant for a real database and cannot be checked.\n` +
        `  Fix the connection, or override with SKIP_MIGRATION_CHECK=1 if you know the schema is current.`,
    );
    return;
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
    // Not fatal anywhere: a deliberate rollback deploys code older than the
    // database, and blocking that would be worse than the confusion it prevents.
    console.warn(
      `! ${target} has recorded ${unknown.length} migration(s) this checkout does not contain: ${unknown.join(", ")}`,
    );
  }

  if (pending.length) {
    report(
      mode,
      `${target} is behind db/migrations - ${pending.length} migration(s) not applied:\n` +
        pending.map((file) => `      ${file}`).join("\n") +
        `\n\n  Apply them to that same database first, then deploy:\n` +
        `      cd apps/web && npm run db:migrate\n\n` +
        `  Deploying this build would return HTTP 500 from every route that needs the missing schema.\n` +
        `  Override with SKIP_MIGRATION_CHECK=1 only if you know why.`,
    );
    return;
  }

  console.log(
    `migration check ok: ${files.length} migration(s) in db/migrations, all applied to ${target}`,
  );
}

main().catch((error) => {
  report(gateMode(process.env), `migration check failed: ${describeError(error)}`);
});
