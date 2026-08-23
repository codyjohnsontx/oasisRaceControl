import { afterAll, beforeEach, expect, it, vi } from "vitest";
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
  /**
   * Re-read on every spread, so a lap always completes after the assignment the
   * case just opened. A constant stamped at import time would sit before every
   * fixture and be refused by the assignment-window guard.
   */
  get completedAt() {
    return new Date().toISOString();
  },
};

/** Closes an assignment the way check-in, staff, or the idle sweep would. */
async function endAssignment(assignmentId: string, reason: string) {
  await testDb().query(
    "update rig_assignments set ended_at = now(), end_reason = $2 where id = $1",
    [assignmentId, reason],
  );
}

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

  it("says so when a second, different lap arrives under an id already stored", async () => {
    // A retry carries the same lap; a lap that lost its identity to another one
    // does not, and the second is silently gone because `on conflict do nothing`
    // cannot tell them apart. The agent no longer mints colliding ids (the run
    // token in LapDetector), so this is the check that speaks up if it ever does
    // again - the answer on the wire stays `duplicate` so an older rig keeps
    // settling it rather than retrying it until closing time.
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    await openAssignment(rig.id, driver.id);
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args);
    });

    try {
      // Same lap number, same combo, same instant - only the time is another
      // driver's. That is the shape of a real collision, and it is the one a
      // comparison that skips the lap time would wave through.
      const first = { ...LAP, eventId: "evt-collision-0001" };
      await POST(post(rig, [first]));
      const second = await POST(post(rig, [{ ...first, lapTimeMs: 104_211 }]));

      await expect(second.json()).resolves.toMatchObject({
        results: [{ status: "duplicate" }],
      });
      expect(await lapRows()).toHaveLength(1);
      expect(JSON.stringify(errors)).toContain("LAP LOST");
      expect(JSON.stringify(errors)).toContain("104211");
    } finally {
      spy.mockRestore();
    }
  });

  it("stays quiet when the same lap is simply delivered again", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    await openAssignment(rig.id, driver.id);
    const event = { ...LAP, eventId: "evt-quiet-retry-0001" };
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args);
    });

    try {
      await POST(post(rig, [event]));
      await POST(post(rig, [event]));
      expect(JSON.stringify(errors)).not.toContain("LAP LOST");
    } finally {
      spy.mockRestore();
    }
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

  it("keeps a queued lap with its own driver when the rig has changed hands", async () => {
    // The venue's connection drops mid-stint, so Alice's lap sits in the rig's
    // outbox while she finishes and the next customer checks in.
    const rig = await seedRig(1);
    const alice = await seedDriver("Alice");
    const bob = await seedDriver("Bob");

    const aliceAssignment = await openAssignment(rig.id, alice.id);
    const drivenAt = new Date().toISOString();
    await endAssignment(aliceAssignment, "driver_ended");
    const bobAssignment = await openAssignment(rig.id, bob.id);

    // Connectivity returns and the agent flushes.
    const response = await POST(
      post(rig, [
        {
          ...LAP,
          eventId: "evt-offline-0001",
          rigAssignmentId: aliceAssignment,
          completedAt: drivenAt,
        },
      ]),
    );

    await expect(response.json()).resolves.toMatchObject({
      results: [{ status: "accepted" }],
    });
    const laps = await lapRows();
    expect(laps).toHaveLength(1);
    expect(laps[0]).toMatchObject({
      driver_id: alice.id,
      rig_assignment_id: aliceAssignment,
    });
    expect(laps[0]!.driver_id).not.toBe(bob.id);
    expect(laps[0]!.rig_assignment_id).not.toBe(bobAssignment);
  });

  it("refuses an unclaimed lap driven before the current customer checked in", async () => {
    // Nobody was checked in while the lap was driven, so the agent stamped no
    // assignment. It must not land on whoever checks in afterwards.
    const rig = await seedRig(1);
    const bob = await seedDriver("Bob");
    const drivenAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await openAssignment(rig.id, bob.id);

    const response = await POST(
      post(rig, [{ ...LAP, eventId: "evt-unowned-0001", completedAt: drivenAt }]),
    );

    await expect(response.json()).resolves.toMatchObject({
      results: [{ status: "no_active_assignment" }],
    });
    expect(await lapRows()).toHaveLength(0);
  });

  it("accepts an unclaimed lap from a driver who checked in seconds before the line", async () => {
    // The agent polls for its assignment every 10s, so a lap finished just
    // after check-in legitimately carries no assignment yet.
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    const assignmentId = await openAssignment(rig.id, driver.id);

    const response = await POST(
      post(rig, [
        { ...LAP, eventId: "evt-pollgap-0001", completedAt: new Date().toISOString() },
      ]),
    );

    await expect(response.json()).resolves.toMatchObject({
      results: [{ status: "accepted" }],
    });
    expect((await lapRows())[0]).toMatchObject({
      driver_id: driver.id,
      rig_assignment_id: assignmentId,
    });
  });

  it("refuses a lap the agent stamped onto an assignment staff had already cleared", async () => {
    // The agent's view of the rig went stale: staff cleared it, someone sat
    // down, and the agent kept crediting the departed driver.
    const rig = await seedRig(1);
    const alice = await seedDriver("Alice");
    const aliceAssignment = await openAssignment(rig.id, alice.id);
    await endAssignment(aliceAssignment, "staff_cleared");

    const response = await POST(
      post(rig, [
        {
          ...LAP,
          eventId: "evt-stale-0001",
          rigAssignmentId: aliceAssignment,
          completedAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ]),
    );

    await expect(response.json()).resolves.toMatchObject({
      results: [{ status: "assignment_mismatch" }],
    });
    expect(await lapRows()).toHaveLength(0);
  });

  it("refuses a lap claiming another rig's assignment", async () => {
    const rigOne = await seedRig(1);
    const rigTwo = await seedRig(2);
    const alice = await seedDriver("Alice");
    const bob = await seedDriver("Bob");
    const rigTwoAssignment = await openAssignment(rigTwo.id, bob.id);
    await openAssignment(rigOne.id, alice.id);

    const response = await POST(
      post(rigOne, [
        { ...LAP, eventId: "evt-foreign-0001", rigAssignmentId: rigTwoAssignment },
      ]),
    );

    await expect(response.json()).resolves.toMatchObject({
      results: [{ status: "assignment_mismatch" }],
    });
    expect(await lapRows()).toHaveLength(0);
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

  it("stores a lap that misses tonight's combo as the clean lap it was", async () => {
    // `is_valid` answers "was this lap clean" and nothing else. Whether it
    // counts tonight is asked at read time by v_fastest_tonight, so a combo
    // typed one character off the sim's own name can be corrected and the whole
    // night reappears - and a walk-in's clean lap on other content is not
    // deleted from that track's permanent board by the venue's schedule.
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
      results: [{ status: "accepted" }],
    });
    const laps = await lapRows();
    expect(laps[0]).toMatchObject({ is_valid: true, invalid_reason: null });

    // ...and it is still kept off tonight's board, by the view rather than by
    // the lap.
    const { rows } = await testDb().query(
      "select driver_id from v_fastest_tonight where driver_id = $1",
      [driver.id],
    );
    expect(rows).toEqual([]);
  });

  it("keeps a lap on other content off tonight's board but on that track's own", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Walk-in Wes");
    await openAssignment(rig.id, driver.id);
    await setFeaturedCombo({
      trackName: "Spa-Francorchamps",
      trackConfig: "Grand Prix Pits",
      carName: "Porsche 911 GT3 R",
    });

    await POST(
      post(rig, [
        { ...LAP, eventId: "evt-monza-0001", trackName: "Monza", trackConfig: null },
      ]),
    );

    const board = await testDb().query(
      `select l.lap_time_ms from laps l join drivers d on d.id = l.driver_id
       where l.is_valid and d.status = 'active' and l.track_name = 'Monza'`,
    );
    expect(board.rows).toHaveLength(1);

    const tonight = await testDb().query(
      "select driver_id from v_fastest_tonight where driver_id = $1",
      [driver.id],
    );
    expect(tonight.rows).toEqual([]);
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

  it("stores a 0x lap that went off the road as invalid, and says why", async () => {
    // The one lap that reaches the board WRONG rather than missing: iRacing
    // charges nothing for a great many offs, so before the agent reported the
    // surface this arrived indistinguishable from a clean lap - and being faster
    // than the clean ones, it went straight to the top.
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    await openAssignment(rig.id, driver.id);
    await setFeaturedCombo({
      trackName: LAP.trackName,
      trackConfig: LAP.trackConfig,
      carName: LAP.carName,
    });

    await POST(
      post(rig, [
        {
          ...LAP,
          eventId: "evt-wide-0001",
          incidentDelta: 0,
          offTrackSeen: true,
          lapTimeMs: 136_204,
        },
        { ...LAP, eventId: "evt-clean-0002", incidentDelta: 0, offTrackSeen: false },
      ]),
    );

    const laps = await lapRows();
    const byTime = new Map(laps.map((l) => [l.lap_time_ms, l]));
    // invalid_reason is a Postgres enum, so this also proves OFF_TRACK is a value
    // the column will take - a reason the database rejects fails the whole batch.
    expect(byTime.get(136_204)).toMatchObject({
      is_valid: false,
      invalid_reason: "OFF_TRACK",
    });
    expect(byTime.get(138_103)).toMatchObject({ is_valid: true, invalid_reason: null });
  });

  it("stores a lap from an agent too old to report the surface as clean", async () => {
    // Rigs are updated one at a time. A missing field must keep the behaviour
    // those machines already have, not void their whole night.
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    await openAssignment(rig.id, driver.id);

    await POST(post(rig, [{ ...LAP, eventId: "evt-old-agent-0001", incidentDelta: 0 }]));

    expect((await lapRows())[0]).toMatchObject({ is_valid: true, invalid_reason: null });
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

  it("shows a rig that cannot read its simulator, naming what is missing", async () => {
    const rig = await seedRig(1);

    await POST(
      post(rig, [
        {
          type: "RIG_HEARTBEAT",
          agentVersion: "1.4.0",
          simHealth: "unreadable",
          simHealthDetail: "the simulator does not publish OnPitRoad",
        },
      ]),
    );

    // Read through the view the staff dashboard reads, not the table - a column
    // the view does not carry never reaches the room.
    const { rows } = await testDb().query<{
      sim_health: string | null;
      sim_health_detail: string | null;
    }>("select sim_health, sim_health_detail from v_rig_status where rig_number = 1");

    expect(rows[0]).toEqual({
      sim_health: "unreadable",
      sim_health_detail: "the simulator does not publish OnPitRoad",
    });
  });

  it("clears the explanation once the rig is scoring again", async () => {
    const rig = await seedRig(1);
    const broken = {
      type: "RIG_HEARTBEAT",
      simHealth: "unreadable",
      simHealthDetail: "the simulator does not publish OnPitRoad",
    };

    await POST(post(rig, [broken]));
    // The venue updates iRacing and the rig starts reading it again. A detail
    // left behind would keep sending staff after a fault that is fixed.
    await POST(post(rig, [{ type: "RIG_HEARTBEAT", simHealth: "scoring" }]));

    const { rows } = await testDb().query<{
      sim_health: string | null;
      sim_health_detail: string | null;
    }>("select sim_health, sim_health_detail from v_rig_status where rig_number = 1");

    expect(rows[0]).toEqual({ sim_health: "scoring", sim_health_detail: null });
  });

  it("makes the reading unknown again when an agent stops reporting it", async () => {
    const rig = await seedRig(1);

    await POST(post(rig, [{ type: "RIG_HEARTBEAT", simHealth: "scoring" }]));
    // A rig rolled back to an older agent. Its last verdict is not evidence
    // about the sim it is reading now, and "scoring" is the dangerous one to
    // leave standing - the agent version it keeps, because that is a fact about
    // the install rather than a live reading.
    await POST(post(rig, [{ type: "RIG_HEARTBEAT", agentVersion: "1.3.0" }]));

    const { rows } = await testDb().query<{
      sim_health: string | null;
      agent_version: string | null;
    }>("select sim_health, agent_version from v_rig_status where rig_number = 1");

    expect(rows[0]).toEqual({ sim_health: null, agent_version: "1.3.0" });
  });

  /**
   * Two simulators installed from one copied folder share a rig token. Nothing
   * in the request says which machine sent it, so before this the backend saw
   * one very busy rig and credited both customers' laps to whoever was checked
   * in. These cases are the whole rule: who owns a rig, when a new machine may
   * take it over, and what happens to a lap while two of them are claiming it.
   */
  const HEARTBEAT_A = {
    type: "RIG_HEARTBEAT" as const,
    agentVersion: "1.4.0",
    installationId: "aaaaaaaabbbbbbbbccccccccdddddddd",
    machineName: "RIG-03",
  };
  const HEARTBEAT_B = {
    type: "RIG_HEARTBEAT" as const,
    agentVersion: "1.4.0",
    installationId: "11111111222222223333333344444444",
    machineName: "RIG-07",
  };

  async function rigIdentity(rigNumber: number) {
    const { rows } = await testDb().query(
      `select agent_machine_name, installation_conflict, installation_conflict_detail
       from v_rig_status where rig_number = $1`,
      [rigNumber],
    );
    return rows[0]!;
  }

  /** Ages the recorded installation past the liveness window the whole rule
   * turns on, which is what a rig PC that was swapped out looks like. */
  async function silenceRecordedInstallation(rigId: string) {
    await testDb().query(
      "update rigs set agent_installation_seen_at = now() - interval '10 minutes' where id = $1",
      [rigId],
    );
  }

  it("records which computer is claiming a rig", async () => {
    const rig = await seedRig(1);

    await POST(post(rig, [HEARTBEAT_A]));

    expect(await rigIdentity(1)).toEqual({
      agent_machine_name: "RIG-03",
      installation_conflict: false,
      installation_conflict_detail: null,
    });
  });

  it("treats the same computer heartbeating again as the same computer", async () => {
    const rig = await seedRig(1);

    // The ordinary case, twice a minute on every rig in the venue for a whole
    // shift. A restart mints no new identity, so nothing here may look like a
    // second machine.
    await POST(post(rig, [HEARTBEAT_A]));
    await POST(post(rig, [HEARTBEAT_A]));

    expect(await rigIdentity(1)).toMatchObject({ installation_conflict: false });
  });

  it("flags two live computers claiming one rig, and names them both", async () => {
    const rig = await seedRig(1);

    await POST(post(rig, [HEARTBEAT_A]));
    await POST(post(rig, [HEARTBEAT_B]));

    expect(await rigIdentity(1)).toEqual({
      // The recorded owner is not handed over to the newcomer: it is still
      // heartbeating, and swapping on every message would flap twice a minute.
      agent_machine_name: "RIG-03",
      installation_conflict: true,
      installation_conflict_detail: "RIG-03 and RIG-07",
    });
  });

  it("does not report two computers with one name as a dashboard glitch", async () => {
    const rig = await seedRig(1);

    // A cloned disk image nobody renamed: two machines, one name. "RIG-03 and
    // RIG-03" reads like a bug in the dashboard, and the actual next step -
    // go and find out which two - is different from the ordinary case.
    await POST(post(rig, [HEARTBEAT_A]));
    await POST(post(rig, [{ ...HEARTBEAT_B, machineName: "RIG-03" }]));

    expect(await rigIdentity(1)).toMatchObject({
      installation_conflict: true,
      installation_conflict_detail: "two computers both calling themselves RIG-03",
    });
  });

  it("lets a replacement machine take a rig over once the old one goes quiet", async () => {
    const rig = await seedRig(1);
    await POST(post(rig, [HEARTBEAT_A]));
    await silenceRecordedInstallation(rig.id);

    // A rig PC that was replaced or re-imaged. Ordinary venue maintenance, and
    // it must not need a database edit or leave a permanent warning on the board.
    await POST(post(rig, [HEARTBEAT_B]));

    expect(await rigIdentity(1)).toEqual({
      agent_machine_name: "RIG-07",
      installation_conflict: false,
      installation_conflict_detail: null,
    });
  });

  it("holds a lap back while two computers are claiming the rig", async () => {
    const rig = await seedRig(1);
    const ana = await seedDriver("Ana");
    await openAssignment(rig.id, ana.id);
    await POST(post(rig, [HEARTBEAT_A]));
    await POST(post(rig, [HEARTBEAT_B]));

    const response = await POST(post(rig, [{ ...LAP, eventId: "evt-conflict-0001" }]));

    // Not stored, and not refused in a way the agent treats as final: the lap
    // stays in that machine's outbox and delivers itself once each rig has its
    // own token. Crediting it to Ana would be a coin toss between two customers.
    await expect(response.json()).resolves.toMatchObject({
      results: [{ status: "rig_conflict", eventId: "evt-conflict-0001" }],
    });
    expect(await lapRows()).toHaveLength(0);
  });

  it("delivers the held laps once the second machine has its own token", async () => {
    const rig = await seedRig(1);
    const ana = await seedDriver("Ana");
    await openAssignment(rig.id, ana.id);
    await POST(post(rig, [HEARTBEAT_A]));
    await POST(post(rig, [HEARTBEAT_B]));
    await POST(post(rig, [{ ...LAP, eventId: "evt-held-0001" }]));

    // Somebody fixes rig 7's config. Its agent stops heartbeating here, so the
    // clash ages out on its own - nothing has to notice that it stopped.
    await testDb().query(
      "update rigs set installation_conflict_at = now() - interval '10 minutes' where id = $1",
      [rig.id],
    );
    const retry = await POST(post(rig, [{ ...LAP, eventId: "evt-held-0001" }]));

    await expect(retry.json()).resolves.toMatchObject({
      results: [{ status: "accepted" }],
    });
    const laps = await lapRows();
    expect(laps).toHaveLength(1);
    expect(laps[0]).toMatchObject({ driver_id: ana.id });
  });

  it("still lets a rig with one computer score while another rig is in conflict", async () => {
    const rigOne = await seedRig(1);
    const rigTwo = await seedRig(2);
    const ana = await seedDriver("Ana");
    const bob = await seedDriver("Bob");
    await openAssignment(rigOne.id, ana.id);
    await openAssignment(rigTwo.id, bob.id);
    await POST(post(rigOne, [HEARTBEAT_A]));
    await POST(post(rigOne, [HEARTBEAT_B]));
    await POST(post(rigTwo, [HEARTBEAT_A]));

    const response = await POST(post(rigTwo, [{ ...LAP, eventId: "evt-otherrig-0001" }]));

    // The conflict is a fact about one rig, not about the venue. Nineteen
    // correctly installed machines keep scoring.
    await expect(response.json()).resolves.toMatchObject({
      results: [{ status: "accepted" }],
    });
    expect(await lapRows()).toHaveLength(1);
  });

  it("leaves the recorded computer alone for an agent too old to name one", async () => {
    const rig = await seedRig(1);
    await POST(post(rig, [HEARTBEAT_A]));

    // A fleet part-way through an update. An older agent says nothing about
    // which machine it is, and silence must not read as a takeover or the rig
    // would flap between claimed and unknown twice a minute.
    await POST(post(rig, [{ type: "RIG_HEARTBEAT", agentVersion: "1.3.0" }]));

    expect(await rigIdentity(1)).toMatchObject({
      agent_machine_name: "RIG-03",
      installation_conflict: false,
    });
  });

  it("keeps scoring a rig whose agent is too old to name its computer", async () => {
    const rig = await seedRig(1);
    const ana = await seedDriver("Ana");
    await openAssignment(rig.id, ana.id);

    await POST(post(rig, [{ type: "RIG_HEARTBEAT", agentVersion: "1.3.0" }]));
    const response = await POST(post(rig, [{ ...LAP, eventId: "evt-oldagent-0001" }]));

    // Rolling this out one rig at a time cannot take the un-updated ones off the
    // leaderboard - unknown is not the same as contested.
    await expect(response.json()).resolves.toMatchObject({
      results: [{ status: "accepted" }],
    });
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
