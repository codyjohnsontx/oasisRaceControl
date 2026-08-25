/**
 * Liveness probe: is this process alive? Kubernetes restarts the container
 * when this stops answering, so it must depend on nothing outside the process -
 * no database, no auth, nothing that can be slow or down for a reason a restart
 * would not fix. A database outage must not turn into a restart loop; that
 * condition is /api/ready's to report.
 *
 * Unauthenticated and constant by design: a probe carries no cookie, and there
 * is nothing here worth protecting.
 */
export function GET() {
  return Response.json({ status: "ok" });
}
