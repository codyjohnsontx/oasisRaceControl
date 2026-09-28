/**
 * What `manual-lap.ts` may say about the lap it just posted, from the
 * per-event result `/api/agent/events` answered with. Its own module, importing
 * nothing, because manual-lap.ts runs on import and so cannot be imported by a
 * test (the same split as soak.ts and its accounting modules).
 *
 * HTTP 200 is not success: the route stores a lap it cannot attribute rather
 * than refusing it. A driver who signs out between the assignment poll and the
 * post leaves the stamped stint closed before the lap's `completedAt`, so the
 * lap lands unclaimed - on the books, crediting nobody. Only `accepted` is the
 * lap the operator asked for.
 */

export type ManualLapOutcome = { ok: boolean; message: string };

export function manualLapOutcome(body: unknown, driverName: string): ManualLapOutcome {
  const results = (body as { results?: unknown } | null)?.results;
  const status =
    Array.isArray(results) && results.length === 1
      ? (results[0] as { status?: unknown } | null)?.status
      : undefined;

  switch (status) {
    case "accepted":
      return { ok: true, message: `stored for ${driverName} and ranking` };
    case "accepted_unattributed":
      return {
        ok: false,
        message:
          `NOT credited to ${driverName}: their check-in on this rig ended before the lap arrived, ` +
          "so it was stored unclaimed (it shows under Unclaimed laps on /staff). " +
          "Check the driver in again and re-run.",
      };
    case "accepted_invalid":
      return {
        ok: false,
        message: `stored for ${driverName} but invalid - it will not rank`,
      };
    case "duplicate":
      return { ok: false, message: "the backend already had a lap with this event id; nothing new was stored" };
    default:
      return {
        ok: false,
        message: `the backend did not report the lap as stored (result: ${JSON.stringify(results ?? body)})`,
      };
  }
}
