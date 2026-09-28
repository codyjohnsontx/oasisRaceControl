/**
 * What `manual-lap.ts` may say about the lap it just posted, from the
 * per-event result `/api/agent/events` answered with. Its own module, importing
 * nothing, because manual-lap.ts runs on import and so cannot be imported by a
 * test (the same split as soak.ts and its accounting modules).
 *
 * HTTP 200 is not success: the route stores a lap it cannot attribute rather
 * than refusing it. The lap's `completedAt` is this machine's clock, and the
 * route credits the stamped stint only when that falls inside the stint's
 * window give or take its clock-skew grace - so a driver signing out between
 * the poll and the post is still credited, and what lands the lap unclaimed
 * (on the books, crediting nobody) is this machine's clock being further off
 * than that grace. Only `accepted` is the lap the operator asked for.
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
          `NOT credited to ${driverName}: the lap fell outside their check-in window on this rig, ` +
          "so it was stored unclaimed (it shows under Unclaimed laps on /staff). " +
          "The lap's time comes from this machine's clock - check it is correct before re-running.",
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
