import { probeDatabase } from "@/lib/readiness";

/**
 * Readiness probe: can this instance serve traffic right now? Every page and
 * route the venue uses needs the database, so the answer is one `select 1`
 * through the app's own pool - the connections a real request would use -
 * bounded by a deadline (src/lib/readiness.ts). A 503 takes the instance out of rotation
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
  const result = await probeDatabase("ready");
  if (!result.ok) return unavailable(result.reason);
  const { appliedMigrations } = result;
  return Response.json(
    appliedMigrations === null ? { status: "ok" } : { status: "ok", appliedMigrations },
  );
}

function unavailable(reason: string): Response {
  return Response.json({ status: "unavailable", reason }, { status: 503 });
}
