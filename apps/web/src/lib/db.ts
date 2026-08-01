import { Pool, type PoolClient } from "pg";

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

/**
 * Run several statements on one client inside a transaction, committing on
 * success and rolling back on any throw. For writes that must not half-apply —
 * an idle client dropping mid-sequence (see the pool note above) would
 * otherwise leave the venue in a state no UI can undo.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db().connect();
  // A rollback that itself fails leaves the connection in an unknown state -
  // possibly still inside the transaction. Returning that to the pool hands the
  // next request a poisoned client, so it gets destroyed instead.
  let rollbackFailed = false;
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {
      rollbackFailed = true;
    });
    throw error;
  } finally {
    client.release(rollbackFailed);
  }
}

/** Postgres unique-violation code, for display-name collisions and races. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "23505"
  );
}
