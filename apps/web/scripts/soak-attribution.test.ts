import { describe, expect, it } from "vitest";
import {
  attributionFailures,
  describeAttributionFailures,
  type ExpectedOwner,
  type StoredLap,
} from "./soak-attribution";

/**
 * The soak's own claim is "every lap is credited to the driver in that seat".
 * The first test here is the one that decides whether that claim is true: it
 * fails against the obvious implementation, which compares a stored lap's
 * driver to the driver of the rig the lap LANDED under. A cross-rig landing
 * satisfies that comparison - the row agrees with itself - so the soak would
 * report the venue's core invariant intact while it was broken.
 */

const RIG_A: ExpectedOwner = { rigNumber: 101, rigId: "rig-a", driverId: "driver-a" };
const RIG_B: ExpectedOwner = { rigNumber: 102, rigId: "rig-b", driverId: "driver-b" };

const announced = (...pairs: Array<[string, ExpectedOwner]>) =>
  new Map<string, ExpectedOwner>(pairs);

describe("attributionFailures", () => {
  it("catches a lap announced by one rig that landed on another rig's driver", () => {
    // Rig A drove it; it is stored under rig B and credited to rig B's driver.
    // Self-consistent, and wrong. This is the case the old check could not see.
    const stored: StoredLap[] = [
      { event_id: "lap-1", rig_id: RIG_B.rigId, driver_id: RIG_B.driverId },
    ];

    const failures = attributionFailures(stored, announced(["lap-1", RIG_A]));

    expect(failures).toEqual([
      { eventId: "lap-1", announcedByRigNumber: 101, reason: "landed_on_another_rig" },
    ]);
  });

  it("catches a lap on the right rig but credited to another driver", () => {
    const stored: StoredLap[] = [
      { event_id: "lap-1", rig_id: RIG_A.rigId, driver_id: "someone-else" },
    ];

    const failures = attributionFailures(stored, announced(["lap-1", RIG_A]));

    expect(failures).toEqual([
      { eventId: "lap-1", announcedByRigNumber: 101, reason: "credited_to_another_driver" },
    ]);
  });

  it("passes laps stored on the rig that announced them", () => {
    const stored: StoredLap[] = [
      { event_id: "lap-1", rig_id: RIG_A.rigId, driver_id: RIG_A.driverId },
      { event_id: "lap-2", rig_id: RIG_B.rigId, driver_id: RIG_B.driverId },
    ];

    const failures = attributionFailures(
      stored,
      announced(["lap-1", RIG_A], ["lap-2", RIG_B]),
    );

    expect(failures).toEqual([]);
  });

  it("leaves an ownerless lap to the unattributed count, not to attribution", () => {
    // A lap the backend refused to credit and one it credited wrongly are
    // opposite failures; the soak reports them separately so the message names
    // which happened. Reporting a null owner here would merge the two.
    const stored: StoredLap[] = [
      { event_id: "lap-1", rig_id: RIG_B.rigId, driver_id: null },
    ];

    expect(attributionFailures(stored, announced(["lap-1", RIG_A]))).toEqual([]);
  });

  it("ignores a lap no rig announced, which is a stray and not a misattribution", () => {
    const stored: StoredLap[] = [
      { event_id: "unknown", rig_id: RIG_A.rigId, driver_id: RIG_A.driverId },
    ];

    expect(attributionFailures(stored, announced())).toEqual([]);
  });

  it("names the announcing rig and the reason so a failure can be chased", () => {
    const stored: StoredLap[] = [
      { event_id: "lap-1", rig_id: RIG_B.rigId, driver_id: RIG_B.driverId },
    ];

    const described = describeAttributionFailures(
      attributionFailures(stored, announced(["lap-1", RIG_A])),
    );

    expect(described).toBe("lap-1 announced by rig 101 (landed on another rig)");
  });
});
