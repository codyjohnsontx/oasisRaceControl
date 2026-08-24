/**
 * Migration bookkeeping, shared by the two scripts that care about it:
 * migrate.ts, which applies what is missing, and check-migrations.ts, which
 * only asserts that nothing is. One definition of "applied" so the gate and
 * the migrator can never disagree about the state of a database, and one
 * definition of the small things both have to say out loud: which database
 * they are talking to, and why they could not reach it.
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

/**
 * A readable one-liner for a thrown error. Node's happy-eyeballs dialer
 * rejects a refused connection with an AggregateError whose own `message` is
 * empty, so printing that verbatim would report "cannot reach the database:"
 * and nothing else - exactly when the reason matters most.
 */
export function describeError(error: unknown): string {
  const err = error as { message?: string; code?: string; errors?: unknown[] };
  if (err?.message) return err.message;

  const attempts = Array.isArray(err?.errors)
    ? err.errors.map((inner) => (inner as Error)?.message).filter(Boolean)
    : [];
  if (attempts.length) return `${err.code ?? "connection failed"}: ${attempts.join("; ")}`;

  return err?.code ?? String(error);
}

/**
 * Which database a connection string points at, as `host/database`.
 * Deliberately partial: the password and the whole query string stay out, so
 * this is safe in a build log a stranger can read.
 *
 * Every script prints it before doing anything, because "which database am I
 * pointed at" has to be answerable by reading one line of output. Inferring it
 * from .env.local does not work - an exported DATABASE_URL beats the file, and
 * dotenv will not override it.
 */
export function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    return `${parsed.host}/${database || "(default database)"}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

/** What a state the gate cannot verify costs: the build, a warning, or nothing. */
export type GateMode = "fail" | "warn" | "skip";

/**
 * How hard to be about a database the gate cannot verify - behind
 * db/migrations, unreachable, no DATABASE_URL at all, or db/migrations not
 * visible to the build. Pure, so the decision is testable without a database.
 *
 * Production is the only build whose output the venue actually sees, so there
 * every one of those states refuses to build: the deploy is rejected and the
 * previous, schema-matching deployment keeps serving.
 *
 * A preview build only warns, and never fails. A pull request that carries a
 * database change still has to produce a preview someone can open, or the gate
 * blocks review of the unrelated code in that change rather than just the
 * deploy. Preview is also where DATABASE_URL is most often simply absent: an
 * environment variable scoped to Production only is not present in any other
 * environment's build.
 *
 * Off Vercel, no DATABASE_URL means no database is configured and there is
 * nothing to compare - a contributor building without Postgres, not a deploy.
 * Set it and the build is meant for a real database, so the gate is back on
 * and tells the developer to run db:migrate.
 */
export function gateMode(env: Record<string, string | undefined>): GateMode {
  if (env.VERCEL_ENV === "production") return "fail";
  if (env.VERCEL) return "warn";
  return env.DATABASE_URL ? "fail" : "skip";
}

/**
 * Whether SKIP_MIGRATION_CHECK is asking for the gate to be off.
 *
 * Only "1" and "true" count. Anything else - "0" and "false" above all - reads
 * as someone spelling out that the check should run, and a guard that turns
 * itself off when told to stay on is the worst possible reading of that.
 */
export function skipRequested(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}
