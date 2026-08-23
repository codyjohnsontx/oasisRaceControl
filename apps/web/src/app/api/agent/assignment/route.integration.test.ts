import { afterAll, beforeEach, expect, it } from "vitest";
import {
  closeTestDb,
  describeDb,
  openAssignment,
  resetDb,
  seedDriver,
  seedRig,
  testDb,
} from "@/test/db";

/**
 * Real-Postgres coverage for the one fact that lets a rig catch an install
 * command run at the wrong computer.
 *
 * A rig's bearer token is its whole identity to this backend, and the number a
 * machine was installed as never travels. So a computer standing at station 4
 * holding rig 7's token authenticates, polls, and delivers - and every lap it
 * sends is credited to rig 7 and to whoever is checked in there, while the
 * customer at station 4 watches a board their times never reach.
 *
 * The comparison can only be made on the rig, and only if this route says who it
 * authenticated. Mocking that answer proves nothing: what has to hold is that the
 * number comes from the row the token actually resolved to, so it is exercised
 * here with real rows and real tokens.
 */

const { GET } = await import("./route");

function poll(token: string) {
  return new Request("http://localhost/api/agent/assignment", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describeDb("agent assignment poll (real Postgres)", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("answers with the rig the token resolves to, not the one that asked", async () => {
    // The whole mechanism, and the reason two rigs are seeded: with only one, a
    // route that answered with any rig row at all would pass.
    await seedRig(4);
    const seven = await seedRig(7);
    await testDb().query("update rigs set display_name = 'Rig 07 - corner' where id = $1", [
      seven.id,
    ]);

    const body = await (await GET(poll(seven.agentToken))).json();

    expect(body.rig).toEqual({ number: 7, displayName: "Rig 07 - corner" });
  });

  it("names the rig with nobody checked in", async () => {
    // The state a machine is enrolled in. If the answer only appeared alongside
    // an assignment, the check would be blind for exactly as long as it matters.
    const rig = await seedRig(4);

    const response = await GET(poll(rig.agentToken));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.assignment).toBeNull();
    expect(body.rig.number).toBe(4);
  });

  it("names the rig alongside a live check-in", async () => {
    const rig = await seedRig(4);
    const driver = await seedDriver("Cody J.");
    await openAssignment(rig.id, driver.id);

    const body = await (await GET(poll(rig.agentToken))).json();

    expect(body.rig.number).toBe(4);
    expect(body.assignment.driver.displayName).toBe("Cody J.");
  });

  it("still refuses a token no rig holds", async () => {
    await seedRig(4);

    const response = await GET(poll("not-any-rigs-token"));

    expect(response.status).toBe(401);
  });
});
