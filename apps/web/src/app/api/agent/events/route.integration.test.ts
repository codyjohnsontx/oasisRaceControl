import { afterAll, beforeEach, expect, it } from "vitest";
import { POST } from "./route";
import {
  assignmentRows,
  closeTestDb,
  describeDb,
  lapRows,
  openAssignment,
  openLeagueRound,
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
 * against the assignment the agent stamped on the lap when it captured it.
 * Attribution deliberately does NOT consult whichever assignment happens to be
 * open when the batch arrives, which is what used to credit a queued lap to the
 * next driver to check in. A lap that cannot be attributed is stored with no
 * driver, invalid and unrankable, rather than guessed at or discarded.
 */

const LAP = {
  type: "LAP_COMPLETED" as const,
  trackName: "Spa-Francorchamps",
  trackConfig: "Grand Prix Pits",
  carName: "Porsche 911 GT3 R",
  lapTimeMs: 138_103,
  incidentDelta: 0,
  /**
   * Evaluated per spread, not once when this module loads. Attribution now
   * checks completedAt against the assignment's window with a 15-minute skew
   * grace, and these cases open their assignment at run time - so a fixed
   * load-time timestamp would quietly couple every one of them to the suite
   * finishing within 15 minutes of import. It would not fail today; it would
   * fail one day as `accepted_unattributed`, pointing at the wrong rule. Cases
   * that care about a specific moment still override this.
   */
  get completedAt() {
    return new Date().toISOString();
  },
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

  it("stores a lap attributed to the assignment the agent stamped on it", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    const assignmentId = await openAssignment(rig.id, driver.id);

    const response = await POST(
      post(rig, [{ ...LAP, eventId: "evt-lap-0001", rigAssignmentId: assignmentId }]),
    );

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
    const assignmentId = await openAssignment(rig.id, driver.id);
    const event = { ...LAP, eventId: "evt-retry-0001", rigAssignmentId: assignmentId };

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
    const assignmentId = await openAssignment(rig.id, driver.id);
    const event = {
      ...LAP,
      eventId: "evt-concurrent-0001",
      rigAssignmentId: assignmentId,
    };

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
    const assignmentId = await openAssignment(rig.id, driver.id);
    const event = {
      ...LAP,
      eventId: "evt-batch-dupe-0001",
      rigAssignmentId: assignmentId,
    };

    const response = await POST(post(rig, [event, event]));

    const body = await response.json();
    expect(body.results.map((r: { status: string }) => r.status)).toEqual([
      "accepted",
      "duplicate",
    ]);
    expect(await lapRows()).toHaveLength(1);
  });

  it("credits a lap flushed after checkout to the driver who drove it", async () => {
    const rig = await seedRig(1);
    const audit = await seedDriver("AuditDriver");
    const second = await seedDriver("SecondDriver");

    // AuditDriver drives a lap, then checks out. The lap is still sitting in
    // the agent's outbox - a venue network blip is all it takes.
    const auditAssignment = await openAssignment(rig.id, audit.id);
    const drivenAt = new Date().toISOString();
    await testDb().query(
      "update rig_assignments set ended_at = now(), end_reason = 'driver_ended' where id = $1",
      [auditAssignment],
    );

    // SecondDriver sits down and checks in before the outbox drains.
    const secondAssignment = await openAssignment(rig.id, second.id);

    const response = await POST(
      post(rig, [
        {
          ...LAP,
          eventId: "evt-backlog-0001",
          rigAssignmentId: auditAssignment,
          completedAt: drivenAt,
        },
      ]),
    );

    await expect(response.json()).resolves.toMatchObject({
      results: [{ status: "accepted" }],
    });

    const laps = await lapRows();
    expect(laps).toHaveLength(1);
    // The lap belongs to whoever was in the seat, even though their assignment
    // is closed and someone else's is open right now.
    expect(laps[0]).toMatchObject({
      driver_id: audit.id,
      rig_assignment_id: auditAssignment,
    });
    expect(laps[0]!.driver_id).not.toBe(second.id);
    expect(laps[0]!.rig_assignment_id).not.toBe(secondAssignment);
  });

  it("stores a lap captured with nobody checked in unattributed, never to the next driver", async () => {
    const rig = await seedRig(1);
    const second = await seedDriver("SecondDriver");
    // The agent knew the rig was unassigned when it captured this lap.
    const orphan = { ...LAP, eventId: "evt-orphan-0001", rigAssignmentId: null };

    await expect((await POST(post(rig, [orphan]))).json()).resolves.toEqual({
      results: [
        {
          type: "LAP_COMPLETED",
          eventId: "evt-orphan-0001",
          status: "accepted_unattributed",
        },
      ],
    });

    const laps = await lapRows();
    expect(laps).toHaveLength(1);
    expect(laps[0]).toMatchObject({
      driver_id: null,
      rig_assignment_id: null,
      is_valid: false,
      invalid_reason: "UNATTRIBUTED",
    });

    // A retry after SecondDriver checks in still does not hand it to them.
    await openAssignment(rig.id, second.id);
    await expect((await POST(post(rig, [orphan]))).json()).resolves.toMatchObject({
      results: [{ status: "duplicate" }],
    });
    expect((await lapRows())[0]!.driver_id).toBeNull();
  });

  it("stores a lap from an agent that sends no assignment id unattributed", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    // An assignment IS open, so guessing would have looked plausible here.
    await openAssignment(rig.id, driver.id);

    // An older agent: the key is absent entirely, which is not the same as the
    // explicit null a current agent sends for an unassigned rig.
    const response = await POST(post(rig, [{ ...LAP, eventId: "evt-legacy-0001" }]));

    await expect(response.json()).resolves.toEqual({
      results: [
        {
          type: "LAP_COMPLETED",
          eventId: "evt-legacy-0001",
          status: "accepted_unattributed",
        },
      ],
    });
    const laps = await lapRows();
    expect(laps[0]).toMatchObject({ driver_id: null, invalid_reason: "UNATTRIBUTED" });
    expect(laps[0]!.driver_id).not.toBe(driver.id);
  });

  it("stores a lap naming an assignment this rig has never had unattributed", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    // A live assignment exists, so a fallback to "whatever is open" would hide
    // the bad id instead of storing the lap ownerless.
    await openAssignment(rig.id, driver.id);

    const response = await POST(
      post(rig, [
        {
          ...LAP,
          eventId: "evt-unknown-0001",
          rigAssignmentId: "00000000-0000-4000-8000-000000000000",
        },
      ]),
    );

    await expect(response.json()).resolves.toMatchObject({
      results: [{ status: "accepted_unattributed" }],
    });
    const laps = await lapRows();
    expect(laps[0]).toMatchObject({ driver_id: null, rig_assignment_id: null });
  });

  it("keeps an unattributed lap off every leaderboard and out of every round", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    const assignmentId = await openAssignment(rig.id, driver.id);
    await setFeaturedCombo({
      trackName: LAP.trackName,
      trackConfig: LAP.trackConfig,
      carName: LAP.carName,
    });
    // An open round on the same combo whose window covers both laps below.
    // Without it v_league_round_laps is empty no matter what the laps look
    // like, and the assertion at the bottom would pass vacuously.
    const roundId = await openLeagueRound({
      trackName: LAP.trackName,
      trackConfig: LAP.trackConfig,
      carName: LAP.carName,
    });

    // A control lap that IS attributed, so each surface below has something to
    // return - an empty result would otherwise prove nothing about the orphan.
    await POST(
      post(rig, [
        {
          ...LAP,
          eventId: "evt-ranked-0001",
          rigAssignmentId: assignmentId,
          lapTimeMs: 138_103,
        },
      ]),
    );
    // A blistering lap that would top the board if it were rankable at all.
    await POST(
      post(rig, [
        {
          ...LAP,
          eventId: "evt-unranked-0001",
          rigAssignmentId: null,
          lapTimeMs: 60_001,
        },
      ]),
    );
    expect(await lapRows()).toHaveLength(2);

    // Fastest Tonight, the board queries, and the league round view all return
    // the control lap and never the faster ownerless one.
    const fastest = await testDb().query(
      "select driver_id, lap_time_ms from v_fastest_tonight",
    );
    expect(fastest.rows).toEqual([{ driver_id: driver.id, lap_time_ms: 138_103 }]);

    const boards = await testDb().query(
      `select l.lap_time_ms from laps l
       join drivers d on d.id = l.driver_id
       where l.is_valid and d.status = 'active'`,
    );
    expect(boards.rows).toEqual([{ lap_time_ms: 138_103 }]);

    const roundLaps = await testDb().query(
      "select round_id, driver_id, lap_time_ms from v_league_round_laps",
    );
    expect(roundLaps.rows).toEqual([
      { round_id: roundId, driver_id: driver.id, lap_time_ms: 138_103 },
    ]);
  });

  it("credits a lap flushed hours after its assignment closed to the driver who drove it", async () => {
    const rig = await seedRig(1);
    const audit = await seedDriver("AuditDriver");
    const later = await seedDriver("LaterDriver");

    // A stint that ran from three hours ago to two, with the lap driven in the
    // middle of it. The rig was offline for the rest of the night, so the lap
    // only reaches the backend now - the case the durable outbox exists for.
    const auditAssignment = await openAssignment(rig.id, audit.id);
    await testDb().query(
      `update rig_assignments
         set started_at = now() - interval '3 hours',
             ended_at = now() - interval '2 hours',
             end_reason = 'driver_ended'
       where id = $1`,
      [auditAssignment],
    );
    await openAssignment(rig.id, later.id);

    const response = await POST(
      post(rig, [
        {
          ...LAP,
          eventId: "evt-longbacklog-0001",
          rigAssignmentId: auditAssignment,
          completedAt: new Date(Date.now() - 150 * 60 * 1000).toISOString(),
        },
      ]),
    );

    await expect(response.json()).resolves.toMatchObject({
      results: [{ status: "accepted" }],
    });
    const laps = await lapRows();
    expect(laps).toHaveLength(1);
    expect(laps[0]).toMatchObject({
      driver_id: audit.id,
      rig_assignment_id: auditAssignment,
    });
  });

  /**
   * Pins the accepted bounded limitation rather than a behaviour anyone wants.
   *
   * An assignment can close without the agent hearing about it - a driver ends
   * their session from their phone, staff clear the rig, or the next customer
   * takes it over - and the agent keeps stamping from its last poll until the
   * next one lands. The window guard bounds that rather than preventing it: a
   * lap driven within ASSIGNMENT_WINDOW_CLOCK_SKEW of ended_at is still
   * credited to the driver who left.
   *
   * This is documented as a known residual and deliberately not fixed on this
   * branch: the agent cannot know a seat changed hands while it was unreachable,
   * and the grace is a symmetric clock-skew tolerance, so tightening it
   * server-side would punish a genuinely skewed rig instead. The test exists so
   * the bound is executable - if this ever changes, it should be because someone
   * chose to change it, not because it drifted unnoticed.
   */
  it("still credits the departed driver inside the grace, the known bounded gap", async () => {
    const rig = await seedRig(1);
    const departed = await seedDriver("DepartedDriver");
    const assignmentId = await openAssignment(rig.id, departed.id);
    // Their stint ended five minutes ago - well inside the 15-minute grace.
    await testDb().query(
      `update rig_assignments
       set started_at = now() - interval '1 hour',
           ended_at = now() - interval '5 minutes',
           end_reason = 'staff_cleared'
       where id = $1`,
      [assignmentId],
    );

    // A lap driven two minutes ago: after they left, before the grace expires.
    const response = await POST(
      post(rig, [
        {
          ...LAP,
          eventId: "evt-in-grace-0001",
          rigAssignmentId: assignmentId,
          completedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        },
      ]),
    );

    await expect(response.json()).resolves.toMatchObject({
      results: [{ status: "accepted" }],
    });
    const laps = await lapRows();
    expect(laps[0]).toMatchObject({
      driver_id: departed.id,
      rig_assignment_id: assignmentId,
    });
  });

  it("stores a lap driven outside the window of the assignment it names unattributed", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");

    // The driver's stint ended an hour ago, well past the clock-skew grace.
    const assignmentId = await openAssignment(rig.id, driver.id);
    await testDb().query(
      `update rig_assignments
         set started_at = now() - interval '2 hours',
             ended_at = now() - interval '1 hour',
             end_reason = 'driver_ended'
       where id = $1`,
      [assignmentId],
    );

    const response = await POST(
      post(rig, [
        {
          ...LAP,
          eventId: "evt-outofwindow-0001",
          rigAssignmentId: assignmentId,
          completedAt: new Date().toISOString(),
        },
      ]),
    );

    // Stored, not dropped and not a 500 - the same treatment as every other
    // lap nobody can be credited with.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      results: [{ status: "accepted_unattributed" }],
    });
    const laps = await lapRows();
    expect(laps).toHaveLength(1);
    expect(laps[0]).toMatchObject({
      driver_id: null,
      rig_assignment_id: null,
      is_valid: false,
      invalid_reason: "UNATTRIBUTED",
    });
  });

  it("will not let an unattributed lap be marked valid", async () => {
    const rig = await seedRig(1);
    await POST(
      post(rig, [{ ...LAP, eventId: "evt-noflip-0001", rigAssignmentId: null }]),
    );

    // The database refuses it, so no route, migration, or console can undo the
    // unrankability of a lap that has no owner.
    await expect(
      testDb().query(
        "update laps set is_valid = true, invalid_reason = null where event_id = $1",
        ["evt-noflip-0001"],
      ),
    ).rejects.toThrow(/laps_unattributed_is_invalid/);
  });

  it("will not let a lap be half-attributed", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    await POST(
      post(rig, [{ ...LAP, eventId: "evt-half-0001", rigAssignmentId: null }]),
    );

    // Giving it a driver without an assignment is a half-written attribution.
    await expect(
      testDb().query("update laps set driver_id = $1 where event_id = $2", [
        driver.id,
        "evt-half-0001",
      ]),
    ).rejects.toThrow(/laps_attribution_all_or_none/);
  });

  it("judges each entry in a batch on its own window, even sharing an event_id", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    const assignmentId = await openAssignment(rig.id, driver.id);
    // A stint that ran from two hours ago until one hour ago.
    await testDb().query(
      `update rig_assignments
       set started_at = now() - interval '2 hours',
           ended_at = now() - interval '1 hour',
           end_reason = 'driver_ended'
       where id = $1`,
      [assignmentId],
    );

    // Two entries sharing one event_id. The first was driven well after that
    // stint closed and must not be credited; the second sits inside it. A
    // lookup keyed on event_id would collapse them and let the second entry's
    // verdict decide the first entry's owner, which is a guard a caller can
    // talk its way around.
    const outOfWindow = {
      ...LAP,
      eventId: "evt-dupe-window-0001",
      rigAssignmentId: assignmentId,
      completedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    };
    const inWindow = { ...outOfWindow, completedAt: new Date(Date.now() - 90 * 60_000).toISOString() };

    const response = await POST(post(rig, [outOfWindow, inWindow]));

    const body = await response.json();
    expect(body.results.map((r: { status: string }) => r.status)).toEqual([
      "accepted_unattributed",
      "duplicate",
    ]);

    const laps = await lapRows();
    expect(laps).toHaveLength(1);
    expect(laps[0]).toMatchObject({ driver_id: null, rig_assignment_id: null });
    expect(laps[0]!.driver_id).not.toBe(driver.id);
  });

  it("never reassigns an earlier driver's lap after a takeover", async () => {
    const rig = await seedRig(1);
    const alice = await seedDriver("Alice");
    const bob = await seedDriver("Bob");

    const aliceAssignment = await openAssignment(rig.id, alice.id);
    await POST(
      post(rig, [
        { ...LAP, eventId: "evt-alice-0001", rigAssignmentId: aliceAssignment },
      ]),
    );

    // Bob takes the rig over.
    await testDb().query(
      "update rig_assignments set ended_at = now(), end_reason = 'takeover' where id = $1",
      [aliceAssignment],
    );
    const bobAssignment = await openAssignment(rig.id, bob.id);
    await POST(
      post(rig, [{ ...LAP, eventId: "evt-bob-0001", rigAssignmentId: bobAssignment }]),
    );

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
    const aliceAssignment = await openAssignment(rigOne.id, alice.id);
    const bobAssignment = await openAssignment(rigTwo.id, bob.id);

    await POST(
      post(rigOne, [
        { ...LAP, eventId: "evt-rig1-0001", rigAssignmentId: aliceAssignment },
      ]),
    );
    await POST(
      post(rigTwo, [
        { ...LAP, eventId: "evt-rig2-0001", rigAssignmentId: bobAssignment },
      ]),
    );

    const laps = await lapRows();
    expect(laps.find((l) => l.event_id === "evt-rig1-0001")?.driver_id).toBe(alice.id);
    expect(laps.find((l) => l.event_id === "evt-rig2-0001")?.driver_id).toBe(bob.id);
  });

  it("stores a lap that misses tonight's combo as invalid with a reason", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    const assignmentId = await openAssignment(rig.id, driver.id);
    await setFeaturedCombo({
      trackName: "Spa-Francorchamps",
      trackConfig: "Grand Prix Pits",
      carName: "Ferrari 296 GT3",
    });

    const response = await POST(
      // Porsche, not Ferrari
      post(rig, [
        { ...LAP, eventId: "evt-wrongcar-0001", rigAssignmentId: assignmentId },
      ]),
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
    const assignmentId = await openAssignment(rig.id, driver.id);
    await setFeaturedCombo({
      trackName: LAP.trackName,
      trackConfig: LAP.trackConfig,
      carName: LAP.carName,
    });

    await POST(
      post(rig, [
        {
          ...LAP,
          eventId: "evt-incident-0001",
          rigAssignmentId: assignmentId,
          incidentDelta: 1,
        },
      ]),
    );

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

  it("does not let one rig's token write a lap onto another rig's assignment", async () => {
    const rigOne = await seedRig(1);
    const rigTwo = await seedRig(2);
    const bob = await seedDriver("Bob");
    // Only rig 2 has a driver; rig 1's agent quotes rig 2's assignment id.
    const bobAssignment = await openAssignment(rigTwo.id, bob.id);

    const response = await POST(
      post(rigOne, [
        { ...LAP, eventId: "evt-crossrig-0001", rigAssignmentId: bobAssignment },
      ]),
    );

    // Stored, but with no owner - rig 1's token cannot reach Bob.
    await expect(response.json()).resolves.toMatchObject({
      results: [{ status: "accepted_unattributed" }],
    });
    const laps = await lapRows();
    expect(laps).toHaveLength(1);
    expect(laps[0]).toMatchObject({ driver_id: null, rig_assignment_id: null });
    // Bob's assignment is untouched.
    const assignments = await assignmentRows();
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({ driver_id: bob.id, ended_at: null });
  });
});
