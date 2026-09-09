/**
 * The soak's attribution reconciliation, kept apart from scripts/soak.ts so it
 * can be tested without a database or a running stack (soak.ts executes on
 * import, so nothing can import it).
 *
 * This is the single check behind the venue's stated core invariant - every lap
 * is credited to the driver who was in that seat - so it is worth stating what
 * it must compare. The obvious version is wrong: matching a stored lap's driver
 * against the driver of the rig the lap LANDED under is a comparison a
 * cross-rig landing wins. Rig A's lap stored under rig B, credited to rig B's
 * driver, agrees with itself and passes a check named for catching exactly
 * that. The stored row cannot be its own witness.
 *
 * So the comparison is against the rig that ANNOUNCED the lap, which only the
 * per-rig metrics know - each worker writes its own file, and that association
 * has to survive into here rather than being flattened away.
 */

/** The columns of `laps` this reconciliation reads. */
export type StoredLap = {
  event_id: string;
  rig_id: string;
  driver_id: string | null;
};

/** Who a lap should belong to, taken from the rig whose metrics announced it. */
export type ExpectedOwner = {
  rigNumber: number;
  rigId: string;
  driverId: string;
};

export type AttributionFailure = {
  eventId: string;
  announcedByRigNumber: number;
  /**
   * `landed_on_another_rig` is the cross-rig case and is the more serious of
   * the two: the lap is on a rig that never drove it. `credited_to_another_driver`
   * is the same rig but the wrong seat, which one-driver-per-rig makes
   * impossible unless the backend chose an owner of its own.
   */
  reason: "landed_on_another_rig" | "credited_to_another_driver";
};

/**
 * Laps whose stored owner disagrees with the rig that announced them.
 *
 * Ownerless laps (`driver_id` null) are deliberately NOT reported here: a lap
 * the backend refused to credit and a lap it credited to the wrong driver are
 * opposite behaviours, and the soak counts them separately so the failure names
 * which one happened. A lap nobody announced is likewise not this function's
 * business - that is a stray, and blaming attribution for it would misname it.
 */
export function attributionFailures(
  stored: readonly StoredLap[],
  announcedBy: ReadonlyMap<string, ExpectedOwner>,
): AttributionFailure[] {
  const failures: AttributionFailure[] = [];
  for (const lap of stored) {
    const expected = announcedBy.get(lap.event_id);
    if (!expected || lap.driver_id === null) continue;
    if (lap.rig_id !== expected.rigId) {
      failures.push({
        eventId: lap.event_id,
        announcedByRigNumber: expected.rigNumber,
        reason: "landed_on_another_rig",
      });
    } else if (lap.driver_id !== expected.driverId) {
      failures.push({
        eventId: lap.event_id,
        announcedByRigNumber: expected.rigNumber,
        reason: "credited_to_another_driver",
      });
    }
  }
  return failures;
}

/** One line per failure, for the check's detail and the console report. */
export function describeAttributionFailures(failures: readonly AttributionFailure[]): string {
  return failures
    .map(
      (f) =>
        `${f.eventId} announced by rig ${f.announcedByRigNumber} ` +
        `(${f.reason.replace(/_/g, " ")})`,
    )
    .join("; ");
}
