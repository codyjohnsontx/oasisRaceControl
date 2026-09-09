import { describe, expect, it } from "vitest";
import {
  accountForLaps,
  type AttemptMetric,
  type Metric,
  type RequestMetric,
} from "./soak-lap-accounting";

/**
 * These cases are not imagined. Each one is a defect this accounting actually
 * shipped and a person, not a machine, caught by reading the diff:
 *
 *  1. an `error` verdict counted as a settled, stored lap
 *  2. a lap announced and never answered for, dropped instead of reported
 *  3. a send the backend never confirmed, counted as a lap the backend LOST
 *  4. an `error` verdict filed under "no outcome recorded"
 *  5. a refusal erased by a later resend that stored the same lap
 *
 * They are a record of real failures, so do not prune them as speculative. The
 * sixth member of this family - a cross-rig landing credited to the wrong
 * driver - belongs to the other half of the reconciliation and is covered by
 * scripts/soak-attribution.test.ts; it is deliberately not duplicated here.
 *
 * Every one of these was silent: the run completed, the summary printed, and
 * the only symptom was a sentence that was not true.
 */

const post = (
  sent: string[],
  results?: Array<{ eventId: string; status: string }>,
): RequestMetric => ({
  t: "2026-09-08T00:00:00.000Z",
  kind: "lap",
  ms: 5,
  status: 200,
  sent,
  ...(results ? { results } : {}),
});

/** A post the rig made and got no usable answer to - a rejected fetch. */
const unansweredPost = (sent: string[]): RequestMetric => ({
  t: "2026-09-08T00:00:00.000Z",
  kind: "lap",
  ms: 5,
  sent,
  error: "fetch failed",
});

/** The line fake-rig writes BEFORE a post leaves it. */
const attempt = (sent: string[]): AttemptMetric => ({
  t: "2026-09-08T00:00:00.000Z",
  kind: "attempt",
  sent,
});

const verdict = (eventId: string, status: string) => ({ eventId, status });

describe("accountForLaps", () => {
  it("does not count a lap the backend answered `error` on as stored", () => {
    // Defect 1: any verdict was treated as settling the lap, so a refusal read
    // as a stored row and the storage check compared it against the database.
    const laps = accountForLaps([post(["lap-1"], [verdict("lap-1", "error")])]);

    expect([...laps.storedIds]).toEqual([]);
    expect(laps.refusedIds).toEqual(["lap-1"]);
  });

  it("reports a lap announced whose post never recorded an outcome", () => {
    // Defect 2: a worker killed between the attempt line and the outcome line
    // left a row nobody could account for. Dropping the attempt made that row a
    // stray - an accusation that the backend invented a lap.
    const metrics: Metric[] = [attempt(["lap-1"])];

    const laps = accountForLaps(metrics);

    expect(laps.sentIds).toEqual([]);
    expect(laps.indeterminateIds).toEqual(["lap-1"]);
  });

  it("holds a send the backend never answered out of the stored set", () => {
    // Defect 3: the storage check's denominator was every distinct id a rig
    // recorded sending, so a lap that may never have arrived was reported as a
    // lap the backend lost.
    const laps = accountForLaps([
      post(["lap-1"], [verdict("lap-1", "accepted")]),
      unansweredPost(["lap-2"]),
    ]);

    expect([...laps.storedIds]).toEqual(["lap-1"]);
    expect(laps.unansweredSentIds).toEqual(["lap-2"]);
    expect(laps.indeterminateIds).toEqual(["lap-2"]);
    expect(laps.refusedIds).toEqual([]);
  });

  it("keeps a refused lap out of the laps with no outcome recorded", () => {
    // Defect 4: an `error` verdict fell into the indeterminate class, so the
    // run said it could not tell whether a lap was stored about a lap the
    // backend had named in its own answer and refused.
    const laps = accountForLaps([post(["lap-1"], [verdict("lap-1", "error")])]);

    expect(laps.indeterminateIds).toEqual([]);
    expect(laps.refusedAndStillMissing).toEqual(["lap-1"]);
  });

  it("still reports a refusal that a later resend stored", () => {
    // Defect 5: refusals were qualified with "and not stored under any other
    // verdict", so fake-rig's deliberate resend emptied the check built to stop
    // a known failure hiding. A refusal happened; a later success does not
    // unmake it, and the retry masking a backend insert failure is the more
    // interesting half.
    const laps = accountForLaps([
      post(["lap-1"], [verdict("lap-1", "error")]),
      post(["lap-1"], [verdict("lap-1", "accepted")]),
    ]);

    expect(laps.refusedIds).toEqual(["lap-1"]);
    expect(laps.refusedThenStored).toEqual(["lap-1"]);
    expect(laps.refusedAndStillMissing).toEqual([]);
    expect([...laps.storedIds]).toEqual(["lap-1"]);
    expect(laps.indeterminateIds).toEqual([]);
  });

  it("declines the duplicate arithmetic when a post was not answered as stored", () => {
    // A refused original leaves nothing for the resend to duplicate: it stores
    // fresh and comes back `accepted`. Counting that as a missing duplicate
    // verdict would blame the idempotency key for the insert failure.
    const laps = accountForLaps([
      post(["lap-1"], [verdict("lap-1", "error")]),
      post(["lap-1"], [verdict("lap-1", "accepted")]),
    ]);

    expect(laps.lapPostsNotStored).toBe(1);
  });

  it("accounts for a clean run with a deliberate resend and holds nothing out", () => {
    const laps = accountForLaps([
      attempt(["lap-1"]),
      post(["lap-1"], [verdict("lap-1", "accepted")]),
      attempt(["lap-1"]),
      post(["lap-1"], [verdict("lap-1", "duplicate")]),
      attempt(["lap-2"]),
      post(["lap-2"], [verdict("lap-2", "accepted_invalid")]),
    ]);

    expect(laps.distinctIds).toEqual(["lap-1", "lap-2"]);
    expect(laps.resends).toBe(1);
    expect([...laps.storedIds]).toEqual(["lap-1", "lap-2"]);
    expect(laps.refusedIds).toEqual([]);
    expect(laps.indeterminateIds).toEqual([]);
    expect(laps.lapPostsNotStored).toBe(0);
  });

  it("ignores heartbeats and polls, which carry no laps", () => {
    const laps = accountForLaps([
      { t: "2026-09-08T00:00:00.000Z", kind: "heartbeat", ms: 4, status: 200, sent: [] },
      { t: "2026-09-08T00:00:00.000Z", kind: "poll", ms: 3, status: 200 },
    ]);

    expect(laps.sentIds).toEqual([]);
    expect(laps.lapPostsNotStored).toBe(0);
  });
});
