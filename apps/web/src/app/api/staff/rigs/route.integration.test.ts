import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { closeTestDb, describeDb, resetDb, testDb, tokenHash } from "@/test/db";

/**
 * Real-Postgres coverage for how a rig gets onto the floor.
 *
 * The property that matters is not that a row appears — it is that the token
 * `/staff` hands an operator is the one the backend will accept from that
 * machine, and that rotating it stops the old one dead. Both ends of that are
 * exercised here through the agent's own authenticated route, because a mint
 * that produced a hash the agent path could not match would look perfect in
 * every unit test and leave twenty-two machines unable to score.
 */

const STAFF = { userId: "", displayName: "Cody" };

vi.mock("@/lib/staff", async () => {
  const actual = await vi.importActual<typeof import("@/lib/staff")>("@/lib/staff");
  return { ...actual, getStaffUser: async () => (STAFF.userId ? STAFF : null) };
});

const { POST: createRigRoute } = await import("./route");
const { POST: rotateRoute } = await import("./rotate-token/route");
const { GET: agentAssignment } = await import("@/app/api/agent/assignment/route");

function createRequest(body: unknown) {
  return new Request("http://localhost/api/staff/rigs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rotateRequest(body: unknown) {
  return new Request("http://localhost/api/staff/rigs/rotate-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The one authenticated read a rig makes on `--check-backend`. */
function agentRequest(token: string) {
  return new Request("http://localhost/api/agent/assignment", {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function createRig(rigNumber: number, displayName?: string) {
  const response = await createRigRoute(
    createRequest({ rigNumber, ...(displayName ? { displayName } : {}) }),
  );
  return { status: response.status, body: await response.json() };
}

describeDb("rig enrolment (real Postgres)", () => {
  beforeEach(async () => {
    await resetDb();
    const { rows } = await testDb().query<{ id: string }>(
      `insert into staff_users (email, password_hash, display_name)
       values ('staff@test.local', 'not-a-real-hash', 'Cody') returning id`,
    );
    STAFF.userId = rows[0]!.id;
  });

  afterAll(closeTestDb);

  it("hands staff a token the agent path accepts, and stores only its hash", async () => {
    const { status, body } = await createRig(21);
    expect(status).toBe(201);

    const { rows } = await testDb().query<{
      id: string;
      agent_token_hash: string;
      display_name: string;
    }>("select id, agent_token_hash, display_name from rigs where rig_number = 21");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_token_hash).toBe(tokenHash(body.agentToken));
    expect(rows[0]!.display_name).toBe("Rig 21");
    // The plaintext is in the response and nowhere in the database.
    expect(JSON.stringify(rows[0])).not.toContain(body.agentToken);

    const authenticated = await agentAssignment(agentRequest(body.agentToken));
    expect(authenticated.status).toBe(200);
    // Also the rig it was minted for: the poll answers with whichever rig the
    // token resolved to, and a mint that crossed two rigs' tokens would leave
    // both machines scoring onto each other with every row looking correct.
    expect(await authenticated.json()).toEqual({
      assignment: null,
      rig: { number: 21, displayName: "Rig 21" },
    });
  });

  it("gives the new rig a working QR slug in the same transaction", async () => {
    const { body } = await createRig(22);

    // The lookup POST /api/checkin makes from a scanned code.
    const { rows } = await testDb().query<{ rig_number: number }>(
      `select r.rig_number from rig_qr_tokens t
       join rigs r on r.id = t.rig_id
       where t.token = $1 and t.active`,
      [body.qrToken],
    );
    expect(rows[0]!.rig_number).toBe(22);
  });

  it("refuses a rig number already on the floor, and adds nothing", async () => {
    await createRig(5);
    const before = await testDb().query("select token from rig_qr_tokens");

    const { status, body } = await createRig(5, "Second Rig 05");

    expect(status).toBe(409);
    expect(body.error).toBe("rig_number_taken");
    const rigs = await testDb().query("select id from rigs");
    expect(rigs.rowCount).toBe(1);
    // The QR slug is written after the rig in the same transaction, so a
    // refused create must not leave one behind pointing at nothing.
    const qr = await testDb().query("select token from rig_qr_tokens");
    expect(qr.rowCount).toBe(before.rowCount);
  });

  it("stops the old token dead when a rig's token is rotated", async () => {
    const { body: created } = await createRig(7);
    const rigId = (
      await testDb().query<{ id: string }>("select id from rigs where rig_number = 7")
    ).rows[0]!.id;

    const response = await rotateRoute(
      rotateRequest({ rigId, reason: "pasted into the group chat" }),
    );
    const rotated = await response.json();

    expect(response.status).toBe(200);
    expect(rotated.agentToken).not.toBe(created.agentToken);
    expect(rotated.rig.rigNumber).toBe(7);

    // What the machine at that rig now gets, until it is re-enrolled.
    expect((await agentAssignment(agentRequest(created.agentToken))).status).toBe(401);
    expect((await agentAssignment(agentRequest(rotated.agentToken))).status).toBe(200);
  });

  it("keeps a rotated rig's QR code and its laps", async () => {
    const { body: created } = await createRig(9);
    const rigId = (
      await testDb().query<{ id: string }>("select id from rigs where rig_number = 9")
    ).rows[0]!.id;

    await rotateRoute(rotateRequest({ rigId }));

    const qr = await testDb().query(
      "select token from rig_qr_tokens where token = $1 and active",
      [created.qrToken],
    );
    // Reprinting twenty-two QR codes because one token leaked is not the deal.
    expect(qr.rowCount).toBe(1);
  });

  it("answers 404 for a rig that is not there", async () => {
    const response = await rotateRoute(
      rotateRequest({ rigId: "11111111-1111-4111-8111-111111111111" }),
    );
    expect(response.status).toBe(404);
  });

  it("records both actions in the audit log without either token", async () => {
    const { body: created } = await createRig(11);
    const rigId = (
      await testDb().query<{ id: string }>("select id from rigs where rig_number = 11")
    ).rows[0]!.id;
    const rotated = await (await rotateRoute(rotateRequest({ rigId }))).json();

    const { rows } = await testDb().query<{
      action: string;
      target_id: string;
      detail: Record<string, unknown> | null;
    }>("select action, target_id, detail from audit_log order by created_at, id");

    expect(rows.map((row) => row.action)).toEqual(["create_rig", "rotate_rig_token"]);
    expect(rows.every((row) => row.target_id === rigId)).toBe(true);
    const audited = JSON.stringify(rows);
    expect(audited).not.toContain(created.agentToken);
    expect(audited).not.toContain(rotated.agentToken);
    // The printed slug is recoverable, so a QR can be reprinted later.
    expect(audited).toContain(created.qrToken);
  });

  it("refuses to enrol a rig for anyone who is not staff", async () => {
    STAFF.userId = "";

    const create = await createRigRoute(createRequest({ rigNumber: 30 }));
    const rotate = await rotateRoute(
      rotateRequest({ rigId: "11111111-1111-4111-8111-111111111111" }),
    );

    expect(create.status).toBe(403);
    expect(rotate.status).toBe(403);
    expect((await testDb().query("select id from rigs")).rowCount).toBe(0);
  });
});
