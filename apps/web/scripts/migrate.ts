/**
 * Applies db/migrations/*.sql in filename order, tracking applied versions in
 * schema_migrations. Pass --seed to also run db/seed.sql afterward.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/migrate.ts [--seed]
 * (reads .env.local automatically in dev)
 *
 * To see what is outstanding without applying it, use scripts/check-migrations.ts
 * (`npm run db:check`), which is read-only and shares this file's bookkeeping.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { config } from "dotenv";
import {
  appliedMigrations,
  describeError,
  describeTarget,
  migrationFiles,
} from "./migrations";

config({ path: [".env.local", ".env"], quiet: true });

const DB_DIR = join(__dirname, "..", "..", "..", "db");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  // Name the database before changing it. .env.local has pointed at local
  // Docker and at Neon at different times, and an already-exported
  // DATABASE_URL beats the file without saying so.
  console.log(`migrating ${describeTarget(url)}`);

  const client = new Client({ connectionString: url });
  await client.connect();

  let locked = false;
  try {
    // Serialize concurrent db:migrate runs (e.g. two deploys racing) — a
    // session advisory lock is held for the whole run and auto-released on
    // disconnect. The constant is an arbitrary app-wide key.
    await client.query("select pg_advisory_lock(4915623001)");
    locked = true;

    await client.query(
      "create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())",
    );

    // Read once, under the lock, rather than re-asking per file: the set
    // cannot change while this run holds it.
    const files = migrationFiles(join(DB_DIR, "migrations"));
    const applied = await appliedMigrations(client);

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip    ${file} (already applied)`);
        continue;
      }
      const sql = readFileSync(join(DB_DIR, "migrations", file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (version) values ($1)", [file]);
        await client.query("commit");
        console.log(`applied ${file}`);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }

    if (process.argv.includes("--seed")) {
      const seed = readFileSync(join(DB_DIR, "seed.sql"), "utf8");
      await client.query(seed);
      console.log("applied seed.sql");
    }
  } finally {
    if (locked) {
      await client.query("select pg_advisory_unlock(4915623001)").catch(() => {});
    }
    await client.end();
  }
}

main().catch((error) => {
  // An unreachable database rejects with an AggregateError whose own message
  // is empty, so the reason has to be dug out of it - applying migrations must
  // never fail with a blank line.
  console.error(describeError(error));
  process.exit(1);
});
