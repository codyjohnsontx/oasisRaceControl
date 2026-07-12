/**
 * Applies db/migrations/*.sql in filename order, tracking applied versions in
 * schema_migrations. Pass --seed to also run db/seed.sql afterward.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/migrate.ts [--seed]
 * (reads .env.local automatically in dev)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

const DB_DIR = join(__dirname, "..", "..", "..", "db");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  // Serialize concurrent db:migrate runs (e.g. two deploys racing) — a session
  // advisory lock is held for the whole run and auto-released on disconnect.
  // The constant is an arbitrary app-wide key.
  await client.query("select pg_advisory_lock(4915623001)");

  try {
    await client.query(
      "create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())",
    );

    const files = readdirSync(join(DB_DIR, "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const { rowCount } = await client.query(
        "select 1 from schema_migrations where version = $1",
        [file],
      );
      if (rowCount) {
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
    await client.query("select pg_advisory_unlock(4915623001)").catch(() => {});
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
