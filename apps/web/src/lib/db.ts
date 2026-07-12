import { Pool } from "pg";

let pool: Pool | undefined;

/**
 * Server-only Postgres pool (Neon in prod, local Postgres in dev). All data
 * access flows through API routes and server components using this pool —
 * there is no direct browser-to-database path.
 *
 * Neon note: use the POOLED connection string (the -pooler host) so serverless
 * instances share PgBouncer connections; include sslmode=require.
 */
export function db(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Missing environment variable DATABASE_URL");
    pool = new Pool({ connectionString: url, max: 5 });
    // Idle clients can error out from under us (Neon closes idle connections
    // on the free tier). Without a listener pg re-throws it as an uncaught
    // exception and takes the process down; log and let the pool recover.
    pool.on("error", (error) => {
      console.error("[db] idle client error", error.message);
    });
  }
  return pool;
}

/** Convenience for the common select/returning shape. */
export async function query<Row extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<Row[]> {
  const result = await db().query(text, params);
  return result.rows as Row[];
}

/** First row or null. */
export async function queryOne<Row extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<Row | null> {
  const rows = await query<Row>(text, params);
  return rows[0] ?? null;
}

/** Postgres unique-violation code, for display-name collisions and races. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "23505"
  );
}
