import { db } from "@/lib/db";

/**
 * How long the database gets to answer before this instance reports itself
 * not ready. A Kubernetes probe has a timeout of its own (timeoutSeconds), and
 * the manifests must set it above this: the answer has to come back inside it
 * as a 503 with a reason, or the probe fails on its own clock and the reason
 * reaches nobody.
 */
const DATABASE_TIMEOUT_MS = 2_000;

class DatabaseTimeout extends Error {
  constructor() {
    super(`database did not answer within ${DATABASE_TIMEOUT_MS}ms`);
  }
}

/**
 * Readiness probe: can this instance serve traffic right now? Every page and
 * route the venue uses needs the database, so the answer is one `select 1`
 * through the app's own pool - the connections a real request would use -
 * bounded by DATABASE_TIMEOUT_MS. A 503 takes the instance out of rotation
 * until the database is back. It is not a restart signal; that is /api/health,
 * and restarting would not bring the database back.
 *
 * Unauthenticated and cheap by design: a probe carries no cookie and runs
 * every few seconds on every replica. The body never carries the error itself
 * - pg quotes connection details in some of them - only a fixed reason and,
 * where pg gave one, its code. The message goes to the server log, tagged.
 *
 * The applied-migration count rides along on a 200 when schema_migrations can
 * be read, so `curl /api/ready` also answers "which schema is this running
 * on". It is informational: a database that answers but has never been
 * migrated is still reported ready, because that is a deploy-order problem
 * the migration gate owns (docs/deploy.md), not a traffic-routing one.
 */
export async function GET() {
  if (!process.env.DATABASE_URL) return unavailable("DATABASE_URL is not set");

  const deadline = Date.now() + DATABASE_TIMEOUT_MS;
  try {
    await withDeadline(db().query("select 1"), deadline);
  } catch (error) {
    console.error("[ready] database probe failed", detail(error));
    return unavailable(reasonFor(error));
  }

  const appliedMigrations = await countAppliedMigrations(deadline);
  return Response.json(
    appliedMigrations === null ? { status: "ok" } : { status: "ok", appliedMigrations },
  );
}

/** Null when the count cannot be read; never a reason to report not ready. */
async function countAppliedMigrations(deadline: number): Promise<number | null> {
  try {
    const { rows } = await withDeadline(
      db().query<{ applied: number }>(
        "select count(*)::int as applied from schema_migrations",
      ),
      deadline,
    );
    return rows[0]?.applied ?? null;
  } catch (error) {
    console.error("[ready] could not count applied migrations", detail(error));
    return null;
  }
}

/** Settles with `promise`, or rejects with DatabaseTimeout once `deadline` passes. */
function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new DatabaseTimeout()),
      Math.max(0, deadline - Date.now()),
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The plain-English reason for a 503. Deliberately not the error message: this
 * body is public, and pg's messages can quote the connection string.
 */
function reasonFor(error: unknown): string {
  if (error instanceof DatabaseTimeout) return error.message;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string"
    ? `database connection or query failed (${code})`
    : "database connection or query failed";
}

/**
 * What the server log gets. A refused connection reaches pg as Node's
 * AggregateError - one inner error per address localhost resolves to - whose
 * own message is empty, so the part worth logging is what it aggregates.
 */
function detail(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.map(detail).join("; ");
  }
  if (error instanceof Error && error.message) return error.message;
  return reasonFor(error);
}

function unavailable(reason: string): Response {
  return Response.json({ status: "unavailable", reason }, { status: 503 });
}
