import { afterAll, beforeEach, expect, it, vi } from "vitest";
import {
  assignmentRows,
  closeTestDb,
  describeDb,
  lapRows,
  openAssignment,
  resetDb,
  seedDriver,
  seedRig,
  testDb,
} from "@/test/db";

/**
 * Real-Postgres coverage for check-in: the checkin_driver() plpgsql function
 * and the one_open_assignment_per_rig / per_driver partial unique indexes.
 *
 * Only the session cookie is mocked. getDriverSession is the first await in the
 * handler, so a queued mock hands each concurrent POST a distinct driver in
 * call order - which is how the two-phones race is reproduced faithfully.
 */

type Session = { driverId: string; displayName: string; isGuest: boolean };

let sticky: Session | null = null;
let queued: Array<Session | null> = [];

vi.mock("@/lib/driver-session", () => ({
  getDriverSession: async () => (queued.length > 0 ? queued.shift()! : sticky),
}));

const { POST } = await import("./route");

function signedInAs(driver: { id: string; displayName: string }) {
  sticky = { driverId: driver.id, displayName: driver.displayName, isGuest: true };
}

function post(qrToken: string, confirm: Record<string, boolean> = {}) {
  return new Request("http://localhost/api/checkin", {
    method: "POST",
    body: JSON.stringify({ qrToken, ...confirm }),
  });
}

async function openAssignments() {
  return (await assignmentRows()).filter((row) => row.ended_at === null);
}

describeDb("POST /api/checkin against real Postgres", () => {
  beforeEach(async () => {
    sticky = null;
    queued = [];
    await resetDb();
  });
  afterAll(closeTestDb);

  it("rejects a request with no driver session", async () => {
    const rig = await seedRig(1);

    const response = await POST(post(rig.qrToken));

    expect(response.status).toBe(401);
    expect(await openAssignments()).toHaveLength(0);
  });

  it("rejects an unknown QR token", async () => {
    const driver = await seedDriver("Cody J");
    signedInAs({ id: driver.id, displayName: driver.displayName });

    const response = await POST(post("not-a-real-token"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "unknown_rig" });
  });

  it("rejects an inactive QR token", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    signedInAs({ id: driver.id, displayName: driver.displayName });
    await testDb().query("update rig_qr_tokens set active = false where token = $1", [
      rig.qrToken,
    ]);

    expect((await POST(post(rig.qrToken))).status).toBe(404);
  });

  it("refuses a banned driver", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    signedInAs({ id: driver.id, displayName: driver.displayName });
    await testDb().query("update drivers set status = 'banned' where id = $1", [
      driver.id,
    ]);

    const response = await POST(post(rig.qrToken));

    expect(response.status).toBe(403);
    expect(await openAssignments()).toHaveLength(0);
  });

  it("checks a driver into an empty rig", async () => {
    const rig = await seedRig(7);
    const driver = await seedDriver("Cody J");
    signedInAs({ id: driver.id, displayName: driver.displayName });

    const response = await POST(post(rig.qrToken));

    const body = await response.json();
    expect(body).toMatchObject({
      status: "checked_in",
      rig: { rig_number: 7 },
    });

    const open = await openAssignments();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ rig_id: rig.id, driver_id: driver.id });
  });

  it("is idempotent when the same driver rescans the same rig", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    signedInAs({ id: driver.id, displayName: driver.displayName });
    const assignmentId = await openAssignment(rig.id, driver.id);

    const response = await POST(post(rig.qrToken));

    await expect(response.json()).resolves.toMatchObject({
      status: "already_checked_in",
      assignmentId,
    });
    expect(await openAssignments()).toHaveLength(1);
  });

  it("asks for takeover confirmation instead of stealing an occupied rig", async () => {
    const rig = await seedRig(1);
    const alice = await seedDriver("Alice");
    const bob = await seedDriver("Bob");
    await openAssignment(rig.id, alice.id);
    signedInAs({ id: bob.id, displayName: bob.displayName });

    const response = await POST(post(rig.qrToken));

    await expect(response.json()).resolves.toMatchObject({
      status: "needs_confirmation",
      needs: { takeover: { currentDriverName: "Alice" } },
    });
    // Nothing changed until Bob confirms.
    const open = await openAssignments();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ driver_id: alice.id });
  });

  it("asks for move confirmation when the driver holds another rig", async () => {
    const rigOne = await seedRig(1);
    const rigTwo = await seedRig(2);
    const driver = await seedDriver("Cody J");
    await openAssignment(rigOne.id, driver.id);
    signedInAs({ id: driver.id, displayName: driver.displayName });

    const response = await POST(post(rigTwo.qrToken));

    await expect(response.json()).resolves.toMatchObject({
      status: "needs_confirmation",
      needs: { move: { fromRigNumber: 1 } },
    });
    expect(await openAssignments()).toHaveLength(1);
  });

  it("closes the old assignment as 'moved' on a confirmed move", async () => {
    const rigOne = await seedRig(1);
    const rigTwo = await seedRig(2);
    const driver = await seedDriver("Cody J");
    const oldAssignment = await openAssignment(rigOne.id, driver.id);
    signedInAs({ id: driver.id, displayName: driver.displayName });

    await POST(post(rigTwo.qrToken, { confirmMove: true }));

    const all = await assignmentRows();
    expect(all).toHaveLength(2);
    expect(all.find((row) => row.id === oldAssignment)).toMatchObject({
      end_reason: "moved",
    });
    const open = await openAssignments();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ rig_id: rigTwo.id, driver_id: driver.id });
  });

  it("closes the previous driver as 'takeover' and leaves their laps alone", async () => {
    const rig = await seedRig(1);
    const alice = await seedDriver("Alice");
    const bob = await seedDriver("Bob");
    const aliceAssignment = await openAssignment(rig.id, alice.id);

    // Alice already set a lap before handing the rig over.
    await testDb().query(
      `insert into laps (event_id, rig_id, rig_assignment_id, driver_id,
                         track_name, car_name, lap_time_ms, is_valid, completed_at)
       values ($1, $2, $3, $4, 'Spa-Francorchamps', 'Porsche 911 GT3 R', 138103, true, now())`,
      ["evt-alice-pre-takeover", rig.id, aliceAssignment, alice.id],
    );

    signedInAs({ id: bob.id, displayName: bob.displayName });
    await POST(post(rig.qrToken, { confirmTakeover: true }));

    expect(
      (await assignmentRows()).find((row) => row.id === aliceAssignment),
    ).toMatchObject({ end_reason: "takeover" });

    const open = await openAssignments();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ driver_id: bob.id });

    // The invariant: her lap keeps her identity and her closed assignment.
    const laps = await lapRows();
    expect(laps).toHaveLength(1);
    expect(laps[0]).toMatchObject({
      driver_id: alice.id,
      rig_assignment_id: aliceAssignment,
    });
  });

  it("lets only one of two simultaneous check-ins hold the rig", async () => {
    const rig = await seedRig(1);
    const alice = await seedDriver("Alice");
    const bob = await seedDriver("Bob");

    // Two phones scanning the same empty rig at the same moment.
    queued = [
      { driverId: alice.id, displayName: "Alice", isGuest: true },
      { driverId: bob.id, displayName: "Bob", isGuest: true },
    ];

    const responses = await Promise.all([
      POST(post(rig.qrToken)),
      POST(post(rig.qrToken)),
    ]);
    const bodies = await Promise.all(responses.map((r) => r.json()));

    // The partial unique index is the arbiter: exactly one open assignment.
    const open = await openAssignments();
    expect(open).toHaveLength(1);

    const winners = bodies.filter((body) => body.status === "checked_in");
    expect(winners).toHaveLength(1);

    // The loser is told to retry rather than silently sharing the rig.
    const losers = responses.filter((response) => response.status === 409);
    const losersNeedingConfirm = bodies.filter(
      (body) => body.status === "needs_confirmation",
    );
    expect(losers.length + losersNeedingConfirm.length).toBe(1);
  });

  it("keeps one open assignment per driver across simultaneous rigs", async () => {
    const rigOne = await seedRig(1);
    const rigTwo = await seedRig(2);
    const driver = await seedDriver("Cody J");

    // Same driver, two rigs, at once - with move pre-confirmed both times.
    queued = [
      { driverId: driver.id, displayName: "Cody J", isGuest: true },
      { driverId: driver.id, displayName: "Cody J", isGuest: true },
    ];

    const responses = await Promise.all([
      POST(post(rigOne.qrToken, { confirmMove: true, confirmTakeover: true })),
      POST(post(rigTwo.qrToken, { confirmMove: true, confirmTakeover: true })),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json()));

    // Two orderings are both correct: the second request either serialized
    // behind the first (checking in, closing the first assignment as 'moved')
    // or lost the per-driver unique-index race and is told to retry. A 500 is
    // not correct, and asserting only the final count would not notice one.
    expect(responses.map((response) => response.status).filter((s) => s >= 500)).toEqual(
      [],
    );
    expect(bodies.filter((body) => body.status === "checked_in").length).toBeGreaterThan(
      0,
    );
    bodies.forEach((body, index) => {
      if (body.status !== "checked_in") {
        expect(responses[index]!.status).toBe(409);
        expect(body).toMatchObject({ error: "conflict_retry" });
      }
    });

    expect(await openAssignments()).toHaveLength(1);
  });
});
