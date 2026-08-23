import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rig's own end of a check-in: the sign-out button at the machine, and the
 * automatic sign-out of a customer who left with iRacing closed behind them
 * (`IdleWatch` in apps/rig-agent). What the request is allowed to say matters as
 * much as what it does - an agent must not be able to claim a reason that belongs
 * to staff, and it must not be able to end a check-in it did not judge.
 */

const queryOne = vi.fn();

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  queryOne: (...args: unknown[]) => queryOne(...args),
  isUniqueViolation: () => false,
}));

const { POST } = await import("./route");

const RIG = { id: "rig-uuid", rig_number: 1, display_name: "Rig 01" };
const TOKEN = "agent-token";
const ASSIGNMENT = "11111111-1111-4111-8111-111111111111";

/** Authenticates the rig; the update returns a closed row unless told otherwise. */
function authenticateRig(closed: { id: string } | null = { id: "assignment-uuid" }) {
  queryOne.mockImplementation(async (sql: string) => {
    if (sql.includes("from rigs where agent_token_hash")) return RIG;
    if (sql.includes("update rig_assignments")) return closed;
    return null;
  });
}

/** The update call's SQL and parameters. */
function updateCall() {
  const call = queryOne.mock.calls.find(([sql]) =>
    String(sql).includes("update rig_assignments"),
  );
  return { sql: String(call?.[0] ?? ""), params: (call?.[1] ?? []) as unknown[] };
}

function post(body?: unknown, authorization: string | null = `Bearer ${TOKEN}`) {
  return new Request("http://localhost/api/agent/checkout", {
    method: "POST",
    headers: authorization ? { authorization } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  queryOne.mockReset();
  queryOne.mockResolvedValue(null);
});

describe("POST /api/agent/checkout", () => {
  it("rejects a request with no rig token without touching the database", async () => {
    const response = await POST(post({}, null));

    expect(response.status).toBe(401);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it("ends whoever is checked in, as a switch, when the agent sends no body at all", async () => {
    // What the sign-out button at the machine means, and what every agent built
    // before the automatic sign-out sends.
    authenticateRig();

    const response = await POST(post());

    await expect(response.json()).resolves.toEqual({ ended: true });
    expect(updateCall().params).toEqual([RIG.id, "switched", null]);
  });

  it("records an automatic sign-out under its own reason", async () => {
    // Not 'switched': a rig that cleared itself and a customer who pressed the
    // button are different nights at the desk when somebody asks what happened.
    authenticateRig();

    const response = await POST(post({ assignmentId: ASSIGNMENT, reason: "idle_timeout" }));

    await expect(response.json()).resolves.toEqual({ ended: true });
    expect(updateCall().params).toEqual([RIG.id, "idle_timeout", ASSIGNMENT]);
  });

  it("closes only the named check-in when the agent names one", async () => {
    authenticateRig();

    await POST(post({ assignmentId: ASSIGNMENT, reason: "idle_timeout" }));

    // The walk-in who scanned the QR code during the countdown is a different
    // row, and this statement must not be able to reach it.
    expect(updateCall().sql).toContain("id = $3::uuid");
  });

  it("reports that it ended nothing when the named check-in is already gone", async () => {
    authenticateRig(null);

    const response = await POST(post({ assignmentId: ASSIGNMENT, reason: "idle_timeout" }));

    await expect(response.json()).resolves.toEqual({ ended: false });
  });

  it("refuses a reason that belongs to staff or to check-in", async () => {
    authenticateRig();

    for (const reason of ["staff_cleared", "takeover", "moved", "driver_ended", ""]) {
      const response = await POST(post({ reason }));

      expect(response.status).toBe(400);
    }
    expect(updateCall().sql).toBe("");
  });

  it("refuses an assignment id that is not one", async () => {
    authenticateRig();

    const response = await POST(post({ assignmentId: "not-a-uuid", reason: "idle_timeout" }));

    expect(response.status).toBe(400);
    expect(updateCall().sql).toBe("");
  });
});
