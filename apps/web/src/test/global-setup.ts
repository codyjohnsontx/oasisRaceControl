import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { safeTestDatabaseUrl } from "./db-guard";

/**
 * Applies db/migrations/*.sql to the throwaway test database once per run.
 *
 * Deliberately does NOT reuse scripts/migrate.ts: that script loads .env.local
 * and reads DATABASE_URL, which in this repo points at live Neon. This applies
 * the same files to the guarded TEST_DATABASE_URL and nothing else.
 *
 * Migrations are applied from scratch every run (drop schema first) so a schema
 * change never leaves the test database half-migrated and silently stale.
 */
export async function setup() {
  const url = safeTestDatabaseUrl();
  if (!url) {
    console.log(
      "[integration] TEST_DATABASE_URL not set - integration tests will skip.",
    );
    return;
  }

  const migrationsDir = join(__dirname, "..", "..", "..", "..", "db", "migrations");
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("drop schema public cascade; create schema public");
    for (const file of files) {
      await client.query(readFileSync(join(migrationsDir, file), "utf8"));
    }
    console.log(`[integration] applied ${files.length} migration(s) to test database`);
  } finally {
    await client.end();
  }
}
