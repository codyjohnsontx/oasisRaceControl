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
  type SeededRig,
} from "@/test/db";

/**
 * Real-Postgres coverage for the "switch driver" endpoint, and specifically for
 * repeating it. The agent no longer drops a checkout it could not deliver: it
 * ends the stint locally, queues the call, and re-sends it when the venue link
 * returns. By then the seat may legitimately belong to somebody else, so what
 * matters here is that a late checkout ends the stint it names and nothing
 * else.
 */
function post(rig: SeededRig, body?: Record<string, unknown>) {
  return new Request("http://localhost/api/agent/checkout", {
    method: "POST",
    headers: { authorization: `Bearer ${rig.agentToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describeDb("POST /api/agent/checkout against real Postgres", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("ends the assignment the agent names", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    const assignmentId = await openAssignment(rig.id, driver.id);

    const response = await POST(post(rig, { assignmentId }));

    await expect(response.json()).resolves.toEqual({ ended: true });
    const [assignment] = await assignmentRows();
    expect(assignment!.ended_at).not.toBeNull();
    expect(assignment!.end_reason).toBe("switched");
  });

  it("leaves the next driver's stint alone when a queued checkout arrives late", async () => {
    const rig = await seedRig(1);
    const first = await seedDriver("FirstDriver");
    const second = await seedDriver("SecondDriver");

    // The first driver signs out during an outage the agent could not deliver
    // through. Their check-in is taken over by the next driver in the meantime,
    // exactly as checkin_driver() does it.
    const firstAssignment = await openAssignment(rig.id, first.id);
    await POST(post(rig, { assignmentId: firstAssignment }));
    const secondAssignment = await openAssignment(rig.id, second.id);

    // The rig reconnects and re-sends the checkout it was still holding.
    const retry = await POST(post(rig, { assignmentId: firstAssignment }));

    // Nothing left to close, and above all not the seat somebody is sitting in.
    await expect(retry.json()).resolves.toEqual({ ended: false });
    const open = (await assignmentRows()).filter((a) => a.ended_at === null);
    expect(open.map((a) => a.id)).toEqual([secondAssignment]);
  });

  it("never reaches past its own rig for the assignment it is told to end", async () => {
    const rig = await seedRig(1);
    const otherRig = await seedRig(2);
    const driver = await seedDriver("Cody J");
    const otherDriver = await seedDriver("Other Driver");
    await openAssignment(rig.id, driver.id);
    const otherAssignment = await openAssignment(otherRig.id, otherDriver.id);

    // Rig 1's token naming rig 2's assignment. Both are open, so a query that
    // forgot to scope by rig would have closed one of them.
    const response = await POST(post(rig, { assignmentId: otherAssignment }));

    await expect(response.json()).resolves.toEqual({ ended: false });
    expect((await assignmentRows()).every((a) => a.ended_at === null)).toBe(true);
  });

  it("ends whatever is open when the agent cannot name a stint", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    await openAssignment(rig.id, driver.id);

    // An agent that has never completed an assignment poll - and every agent
    // built before the checkout carried a target - sends no body at all.
    const response = await POST(post(rig));

    await expect(response.json()).resolves.toEqual({ ended: true });
    expect((await assignmentRows())[0]!.end_reason).toBe("switched");
  });

  it("answers false rather than erroring when nobody is checked in", async () => {
    const rig = await seedRig(1);

    await expect((await POST(post(rig, {}))).json()).resolves.toEqual({ ended: false });
  });
});
