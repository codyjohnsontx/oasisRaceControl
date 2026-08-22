/**
 * Migration bookkeeping, shared by the two scripts that care about it:
 * migrate.ts, which applies what is missing, and check-migrations.ts, which
 * only asserts that nothing is. One definition of "applied" so the gate and
 * the migrator can never disagree about the state of a database.
 *
 * Nothing here writes. Creating schema_migrations is migrate.ts's job alone.
 */
import { readdirSync } from "node:fs";

/** Only `query` is used, so either a pg Client or a PoolClient fits. */
type Queryable = {
  query<Row extends Record<string, unknown>>(text: string): Promise<{ rows: Row[] }>;
};

/** Every migration in `dir`, in the order they must be applied. */
export function migrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

/**
 * Versions the database has recorded.
 *
 * A database with no schema_migrations table has simply never been migrated,
 * which is migration zero rather than an error. to_regclass answers that
 * without a failed lookup: `select ... from schema_migrations` would raise
 * 42P01 at parse time, which also aborts any surrounding transaction. Left
 * unqualified so it resolves through the same search_path the migrator writes
 * through.
 */
export async function appliedMigrations(client: Queryable): Promise<Set<string>> {
  const table = await client.query<{ name: string | null }>(
    "select to_regclass('schema_migrations')::text as name",
  );
  if (!table.rows[0]?.name) return new Set();

  const { rows } = await client.query<{ version: string }>(
    "select version from schema_migrations",
  );
  return new Set(rows.map((row) => row.version));
}

/** Files the database has not recorded, still in apply order. */
export function pendingMigrations(files: string[], applied: Set<string>): string[] {
  return files.filter((file) => !applied.has(file));
}

/**
 * Versions the database has recorded that have no file on disk. Not the
 * failure mode this gate exists for - that is pendingMigrations - but it means
 * the checkout is older than the database, or a migration was renamed. Worth
 * saying out loud rather than leaving someone to infer it from a schema that
 * holds more than the files explain.
 */
export function unknownApplied(files: string[], applied: Set<string>): string[] {
  const known = new Set(files);
  return [...applied].filter((version) => !known.has(version)).sort();
}
