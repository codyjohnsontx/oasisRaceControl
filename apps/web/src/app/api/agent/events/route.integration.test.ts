import { afterAll, beforeEach, expect, it } from "vitest";
import { POST } from "./route";
import {
  assignmentRows,
  closeTestDb,
  describeDb,
  lapRows,
  openAssignment,
  resetDb,
  seedDriver,
  seedRig,
  setFeaturedCombo,
  testDb,
  type SeededRig,
} from "@/test/db";

/**
 * Real-Postgres coverage for the project's core invariant: every lap is
 * attributed to the correct driver, exactly once, and never reassigned.
 *
 * These cases exercise the parts that only the database can enforce - the
 * unique event_id index behind `on conflict do nothing`, and attribution
 * against the rig's open assignment at ingestion time.
 */

const LAP = {
  type: "LAP_COMPLETED" as const,
  trackName: "Spa-Francorchamps",
  trackConfig: "Grand Prix Pits",
  carName: "Porsche 911 GT3 R",
  lapTimeMs: 138_103,
  incidentDelta: 0,
  completedAt: new Date().toISOString(),
};

function post(rig: SeededRig, events: unknown[]) {
  return new Request("http://localhost/api/agent/events", {
    method: "POST",
    headers: { authorization: `Bearer ${rig.agentToken}` },
    body: JSON.stringify({ events }),
  });
}

describeDb("POST /api/agent/events against real Postgres", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("stores a lap attributed to the rig's open assignment", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    const assignmentId = await openAssignment(rig.id, driver.id);

    const response = await POST(post(rig, [{ ...LAP, eventId: "evt-lap-0001" }]));

    await expect(response.json()).resolves.toEqual({
      results: [{ type: "LAP_COMPLETED", eventId: "evt-lap-0001", status: "accepted" }],
    });

    const laps = await lapRows();
    expect(laps).toHaveLength(1);
    expect(laps[0]).toMatchObject({
      event_id: "evt-lap-0001",
      driver_id: driver.id,
      rig_assignment_id: assignmentId,
      is_valid: true,
      invalid_reason: null,
    });
  });

  it("stores the same event_id exactly once when the agent retries", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    await openAssignment(rig.id, driver.id);
    const event = { ...LAP, eventId: "evt-retry-0001" };

    const first = await POST(post(rig, [event]));
    const second = await POST(post(rig, [event]));

    await expect(first.json()).resolves.toMatchObject({
      results: [{ status: "accepted" }],
    });
    await expect(second.json()).resolves.toMatchObject({
      results: [{ status: "duplicate" }],
    });
    expect(await lapRows()).toHaveLength(1);
  });

  it("survives the same event arriving twice concurrently", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    await openAssignment(rig.id, driver.id);
    const event = { ...LAP, eventId: "evt-concurrent-0001" };

    // Two in-flight retries of the same queued event, as a flaky venue
    // connection would produce.
    const responses = await Promise.all([
      POST(post(rig, [event])),
      POST(post(rig, [event])),
    ]);
    const bodies = await Promise.all(responses.map((r) => r.json()));
    const statuses = bodies.map((b) => b.results[0].status).sort();

    expect(await lapRows()).toHaveLength(1);
    expect(statuses).toEqual(["accepted", "duplicate"]);
  });

  it("deduplicates a repeated event inside a single batch", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    await openAssignment(rig.id, driver.id);
    const event = { ...LAP, eventId: "evt-batch-dupe-0001" };

    const response = await POST(post(rig, [event, event]));

    const body = await response.json();
    expect(body.results.map((r: { status: string }) => r.status)).toEqual([
      "accepted",
      "duplicate",
    ]);
    expect(await lapRows()).toHaveLength(1);
  });

  it("rejects a lap when no assignment is open rather than guessing an owner", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    // Assignment opened then closed: the driver has left.
    const assignmentId = await openAssignment(rig.id, driver.id);
    await testDb().query(
      "update rig_assignments set ended_at = now(), end_reason = 'driver_ended' where id = $1",
      [assignmentId],
    );

    const response = await POST(post(rig, [{ ...LAP, eventId: "evt-orphan-0001" }]));

    await expect(response.json()).resolves.toEqual({
      results: [
        {
          type: "LAP_COMPLETED",
          eventId: "evt-orphan-0001",
          status: "no_active_assignment",
        },
      ],
    });
    expect(await lapRows()).toHaveLength(0);
  });

  it("never reassigns an earlier driver's lap after a takeover", async () => {
    const rig = await seedRig(1);
    const alice = await seedDriver("Alice");
    const bob = await seedDriver("Bob");

    const aliceAssignment = await openAssignment(rig.id, alice.id);
    await POST(post(rig, [{ ...LAP, eventId: "evt-alice-0001" }]));

    // Bob takes the rig over.
    await testDb().query(
      "update rig_assignments set ended_at = now(), end_reason = 'takeover' where id = $1",
      [aliceAssignment],
    );
    const bobAssignment = await openAssignment(rig.id, bob.id);
    await POST(post(rig, [{ ...LAP, eventId: "evt-bob-0001" }]));

    const laps = await lapRows();
    expect(laps).toHaveLength(2);

    const aliceLap = laps.find((lap) => lap.event_id === "evt-alice-0001");
    const bobLap = laps.find((lap) => lap.event_id === "evt-bob-0001");

    // Alice's lap keeps her identity and her now-closed assignment.
    expect(aliceLap).toMatchObject({
      driver_id: alice.id,
      rig_assignment_id: aliceAssignment,
    });
    expect(bobLap).toMatchObject({
      driver_id: bob.id,
      rig_assignment_id: bobAssignment,
    });
  });

  it("keeps each rig's laps on its own assignment", async () => {
    const rigOne = await seedRig(1);
    const rigTwo = await seedRig(2);
    const alice = await seedDriver("Alice");
    const bob = await seedDriver("Bob");
    await openAssignment(rigOne.id, alice.id);
    await openAssignment(rigTwo.id, bob.id);

    await POST(post(rigOne, [{ ...LAP, eventId: "evt-rig1-0001" }]));
    await POST(post(rigTwo, [{ ...LAP, eventId: "evt-rig2-0001" }]));

    const laps = await lapRows();
    expect(laps.find((l) => l.event_id === "evt-rig1-0001")?.driver_id).toBe(alice.id);
    expect(laps.find((l) => l.event_id === "evt-rig2-0001")?.driver_id).toBe(bob.id);
  });

  it("stores a lap that misses tonight's combo as invalid with a reason", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    await openAssignment(rig.id, driver.id);
    await setFeaturedCombo({
      trackName: "Spa-Francorchamps",
      trackConfig: "Grand Prix Pits",
      carName: "Ferrari 296 GT3",
    });

    const response = await POST(
      post(rig, [{ ...LAP, eventId: "evt-wrongcar-0001" }]), // Porsche, not Ferrari
    );

    await expect(response.json()).resolves.toMatchObject({
      results: [{ status: "accepted_invalid" }],
    });
    const laps = await lapRows();
    expect(laps[0]).toMatchObject({ is_valid: false, invalid_reason: "WRONG_CAR" });
  });

  it("stores an incident lap as invalid under the 0x rule", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    await openAssignment(rig.id, driver.id);
    await setFeaturedCombo({
      trackName: LAP.trackName,
      trackConfig: LAP.trackConfig,
      carName: LAP.carName,
    });

    await POST(post(rig, [{ ...LAP, eventId: "evt-incident-0001", incidentDelta: 1 }]));

    const laps = await lapRows();
    expect(laps[0]).toMatchObject({
      is_valid: false,
      invalid_reason: "INCIDENT_LIMIT_EXCEEDED",
    });
  });

  it("records a heartbeat against the authenticated rig only", async () => {
    const rigOne = await seedRig(1);
    await seedRig(2);

    await POST(post(rigOne, [{ type: "RIG_HEARTBEAT", agentVersion: "1.4.0" }]));

    const { rows } = await testDb().query<{
      rig_number: number;
      agent_version: string | null;
      last_seen_at: Date | null;
    }>("select rig_number, agent_version, last_seen_at from rigs order by rig_number");

    expect(rows[0]).toMatchObject({ rig_number: 1, agent_version: "1.4.0" });
    expect(rows[0]!.last_seen_at).not.toBeNull();
    // Rig 2 was never touched by rig 1's token.
    expect(rows[1]).toMatchObject({ rig_number: 2, agent_version: null });
    expect(rows[1]!.last_seen_at).toBeNull();
  });

  it("does not let one rig's token write a lap for another rig", async () => {
    const rigOne = await seedRig(1);
    const rigTwo = await seedRig(2);
    const bob = await seedDriver("Bob");
    // Only rig 2 has a driver; rig 1's agent submits a lap.
    await openAssignment(rigTwo.id, bob.id);

    const response = await POST(post(rigOne, [{ ...LAP, eventId: "evt-crossrig-0001" }]));

    await expect(response.json()).resolves.toMatchObject({
      results: [{ status: "no_active_assignment" }],
    });
    expect(await lapRows()).toHaveLength(0);
    // Bob's assignment is untouched.
    const assignments = await assignmentRows();
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({ driver_id: bob.id, ended_at: null });
  });
});
