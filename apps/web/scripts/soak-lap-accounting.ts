/**
 * The soak's lap accounting, kept apart from scripts/soak.ts so it can be
 * tested without a database or a running stack (soak.ts executes on import, so
 * nothing can import it).
 *
 * This block decides what every check in the summary is ALLOWED to claim, and a
 * wrong label here is silent: the run still completes, the summary still
 * prints, and the only symptom is a sentence that is not true. It has been
 * wrong five separate times, each caught by a person reading the diff and never
 * by a machine - see scripts/soak-lap-accounting.test.ts, whose cases are those
 * five defects.
 *
 * Two framings, deliberately kept apart, because collapsing them into one is
 * what let a refusal disappear. IDS answer storage accounting - was this lap
 * ultimately stored - and a set is the right model for that. VERDICTS answer
 * what the backend DID, and are counted as the events they were: a refusal
 * happened whatever a later resend went on to do. A lap can honestly be both
 * refused once and ultimately stored, and this module reports both rather than
 * letting the second cancel the first.
 */

/** One request as the rig experienced it (scripts/fake-rig.ts --metrics). */
export type RequestMetric = {
  t: string;
  kind: "lap" | "heartbeat" | "poll";
  ms: number;
  status?: number;
  error?: string;
  sent?: string[];
  results?: Array<{ eventId?: string; status: string }>;
};

/**
 * A lap the rig had begun sending, written before the request left it. A worker
 * killed between the backend committing the row and its outcome line being
 * written leaves this line and no other, which is the difference between "the
 * backend produced a lap nobody sent" and "this run cannot account for one lap"
 * - the first is an accusation, the second is the truth. Not a request: it is
 * never counted or timed as one.
 */
export type AttemptMetric = { t: string; kind: "attempt"; sent: string[] };

export type Metric = RequestMetric | AttemptMetric;

export type Verdict = { eventId?: string; status: string };

export type LapAccounting = {
  /** Every id a lap post recorded sending, resends included. */
  sentIds: string[];
  distinctIds: string[];
  /** Sends beyond the first for the same id - fake-rig re-sends deliberately. */
  resends: number;
  verdicts: Verdict[];
  /**
   * Laps the backend answered with a verdict that is not `error`, so the row is
   * there. This and only this is the storage check's denominator: a lap the
   * backend never said it holds must not be reported as one it lost.
   */
  storedIds: Set<string>;
  /**
   * Laps the backend answered `error` on at least once - the insert threw and
   * it said so. Read off the verdicts, never qualified by how the lap ended up,
   * because a refusal is an event and a later resend does not unmake it.
   */
  refusedIds: string[];
  /**
   * Refused laps a later resend did store. The retry path masking a real
   * ingestion failure is the more interesting half, not the less.
   */
  refusedThenStored: string[];
  /** Refused laps the backend still does not hold - held out of the denominator. */
  refusedAndStillMissing: string[];
  /** Sent, and carrying no verdict at all: the answer never arrived or could not be read. */
  unansweredSentIds: string[];
  /**
   * Laps this run cannot account for: no verdict at all, either because the
   * worker was killed between announcing the lap and recording its outcome, or
   * because the answer never arrived. Terminal state IS the right model here -
   * the question is whether the run can account for the lap, and a later
   * answered post does account for it; the failed post itself is not lost
   * either way, since the request check counts it as an event and
   * `lapPostsNotStored` makes the duplicate arithmetic decline to rule.
   */
  indeterminateIds: string[];
  /**
   * Lap posts the backend did not answer as stored for every id they carried -
   * no verdict, or an `error` one. Either way a later resend of that id stores
   * fresh rather than duplicating, so the duplicate arithmetic cannot be
   * computed and must not claim to be.
   */
  lapPostsNotStored: number;
};

export function accountForLaps(metrics: readonly Metric[]): LapAccounting {
  const lapPosts = metrics.filter(
    (m): m is RequestMetric => m.kind === "lap",
  );
  const attempts = metrics.filter((m): m is AttemptMetric => m.kind === "attempt");

  const sentIds = lapPosts.flatMap((m) => m.sent ?? []);
  const distinctIds = [...new Set(sentIds)];
  const verdicts = lapPosts.flatMap((m) => m.results ?? []);

  const outcomeRecorded = new Set(sentIds);
  const storedIds = new Set(
    lapPosts.flatMap((m) =>
      (m.sent ?? []).filter((id) =>
        (m.results ?? []).some((r) => r.eventId === id && r.status !== "error"),
      ),
    ),
  );
  const refusedIds = [
    ...new Set(
      verdicts.flatMap((v) => (v.status === "error" && v.eventId ? [v.eventId] : [])),
    ),
  ];
  const refused = new Set(refusedIds);
  const unansweredSentIds = distinctIds.filter(
    (id) => !storedIds.has(id) && !refused.has(id),
  );

  return {
    sentIds,
    distinctIds,
    resends: sentIds.length - distinctIds.length,
    verdicts,
    storedIds,
    refusedIds,
    refusedThenStored: refusedIds.filter((id) => storedIds.has(id)),
    refusedAndStillMissing: refusedIds.filter((id) => !storedIds.has(id)),
    unansweredSentIds,
    indeterminateIds: [
      ...new Set([
        ...attempts.flatMap((m) => m.sent).filter((id) => !outcomeRecorded.has(id)),
        ...unansweredSentIds,
      ]),
    ],
    lapPostsNotStored: lapPosts.filter(
      (m) =>
        (m.results ?? []).filter((r) => r.status !== "error").length !==
        (m.sent ?? []).length,
    ).length,
  };
}
