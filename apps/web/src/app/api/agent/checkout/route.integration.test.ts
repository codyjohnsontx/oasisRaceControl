import { afterAll, beforeEach, expect, it } from "vitest";
import { POST } from "./route";
import {
  assignmentRows,
  closeTestDb,
  describeDb,
  openAssignment,
  resetDb,
  seedDriver,
  seedRig,
  testDb,
  type SeededRig,
} from "@/test/db";

/**
 * Real-Postgres coverage for the rig ending a check-in.
 *
 * The reason is a Postgres enum and the scoping is a `where` clause, so neither
 * is proven by a mocked pool: a reason the enum does not carry fails at the
 * database, and the clause that keeps an automatic sign-out off the wrong
 * customer either matches one row or the wrong one.
 */

function post(rig: SeededRig, body?: unknown) {
  return new Request("http://localhost/api/agent/checkout", {
    method: "POST",
    headers: { authorization: `Bearer ${rig.agentToken}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describeDb("POST /api/agent/checkout against real Postgres", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("records an automatic sign-out as idle_timeout", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Walkaway Wendy");
    const assignmentId = await openAssignment(rig.id, driver.id);

    const response = await POST(post(rig, { assignmentId, reason: "idle_timeout" }));

    await expect(response.json()).resolves.toEqual({ ended: true });
    const [assignment] = await assignmentRows();
    expect(assignment.ended_at).not.toBeNull();
    // The value has to be one the enum carries, or this write is a 500 on every
    // rig in the venue every time somebody walks away.
    expect(assignment.end_reason).toBe("idle_timeout");
  });

  it("leaves the walk-in who checked in during the countdown alone", async () => {
    // The rig decides after watching a closed simulator for several minutes, and
    // in that gap the next customer scans the QR code and takes the rig over. The
    // request names the check-in it judged, which by then is closed - so it must
    // close nothing rather than end the session of the person now sitting there.
    const rig = await seedRig(1);
    const wendy = await seedDriver("Walkaway Wendy");
    const walkIn = await seedDriver("Next Up");
    const wendyAssignment = await openAssignment(rig.id, wendy.id);

    await takeOver(rig.id, wendyAssignment);
    const walkInAssignment = await openAssignment(rig.id, walkIn.id);

    const response = await POST(post(rig, { assignmentId: wendyAssignment, reason: "idle_timeout" }));

    await expect(response.json()).resolves.toEqual({ ended: false });
    const open = (await assignmentRows()).filter((a) => a.ended_at === null);
    expect(open.map((a) => a.id)).toEqual([walkInAssignment]);
    expect(open[0].driver_id).toBe(walkIn.id);
  });

  it("still ends whoever is checked in when the agent names nobody", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    await openAssignment(rig.id, driver.id);

    const response = await POST(post(rig));

    await expect(response.json()).resolves.toEqual({ ended: true });
    const [assignment] = await assignmentRows();
    expect(assignment.end_reason).toBe("switched");
  });

  it("never reaches another rig's check-in", async () => {
    const rig = await seedRig(1);
    const other = await seedRig(2);
    const driver = await seedDriver("Cody J");
    const theirs = await openAssignment(other.id, driver.id);

    const response = await POST(post(rig, { assignmentId: theirs, reason: "idle_timeout" }));

    await expect(response.json()).resolves.toEqual({ ended: false });
    const [assignment] = await assignmentRows();
    expect(assignment.ended_at).toBeNull();
  });
});

/** Closes an assignment the way the check-in function's takeover branch does. */
async function takeOver(rigId: string, assignmentId: string) {
  await testDb().query(
    "update rig_assignments set ended_at = now(), end_reason = 'takeover' where id = $1 and rig_id = $2",
    [assignmentId, rigId],
  );
}
