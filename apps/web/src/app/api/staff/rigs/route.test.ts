import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentTokenHash } from "@/lib/agent-auth";
import { AGENT_TOKEN_PREFIX } from "@/lib/rig-enrolment";

/**
 * Adding a rig to the fleet. The venue does this twenty-plus times in one
 * evening, and the thing that must never happen is a rig whose credentials
 * exist somewhere a person can read them later.
 */

type Call = { sql: string; params: unknown[] };
const calls: Call[] = [];
let insertError: unknown = null;

const client = {
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes("insert into rigs")) {
      if (insertError) throw insertError;
      return { rows: [{ id: "rig-uuid" }] };
    }
    return { rows: [] };
  }),
};

vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    ...actual,
    query: vi.fn(),
    queryOne: vi.fn(),
    withTransaction: (fn: (c: unknown) => Promise<unknown>) => fn(client),
  };
});

const getStaffUser = vi.fn();
const writeAudit = vi.fn();
vi.mock("@/lib/staff", () => ({
  getStaffUser: () => getStaffUser(),
  writeAudit: (entry: unknown) => writeAudit(entry),
}));

const { POST } = await import("./route");

const STAFF = { userId: "staff-uuid", displayName: "Cody" };

function post(body: unknown) {
  return new Request("http://localhost/api/staff/rigs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rigInsert(): Call {
  return calls.find((call) => call.sql.includes("insert into rigs"))!;
}

beforeEach(() => {
  calls.length = 0;
  insertError = null;
  client.query.mockClear();
  writeAudit.mockReset();
  getStaffUser.mockReset();
  getStaffUser.mockResolvedValue(STAFF);
});

describe("POST /api/staff/rigs", () => {
  it("refuses anyone who is not signed in as staff, before touching the database", async () => {
    getStaffUser.mockResolvedValue(null);

    const response = await POST(post({ rigNumber: 4 }));

    expect(response.status).toBe(403);
    expect(client.query).not.toHaveBeenCalled();
  });

  it("returns the new rig's token exactly once, and stores only its hash", async () => {
    const response = await POST(post({ rigNumber: 7 }));
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload.agentToken).toMatch(/^oasisrig_[A-Za-z0-9_-]{43}$/);

    const stored = rigInsert().params[2] as string;
    expect(stored).toBe(agentTokenHash(payload.agentToken));
    // The plaintext must not reach any statement, or it is in the database.
    expect(JSON.stringify(calls)).not.toContain(payload.agentToken);
  });

  it("mints a different token for every rig", async () => {
    const first = await (await POST(post({ rigNumber: 1 }))).json();
    const second = await (await POST(post({ rigNumber: 2 }))).json();

    expect(first.agentToken).not.toBe(second.agentToken);
    expect(first.qrToken).not.toBe(second.qrToken);
  });

  it("never accepts a token from the request", async () => {
    const response = await POST(
      post({ rigNumber: 9, agentToken: "dev-rig-1-secret" }),
    );
    const payload = await response.json();

    expect(payload.agentToken.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);
    expect(rigInsert().params[2]).not.toBe(agentTokenHash("dev-rig-1-secret"));
  });

  it("creates the QR slug the customer scans in the same transaction", async () => {
    const payload = await (await POST(post({ rigNumber: 12 }))).json();

    const qr = calls.find((call) => call.sql.includes("insert into rig_qr_tokens"))!;
    expect(qr.params[0]).toBe(payload.qrToken);
    expect(qr.params[1]).toBe("rig-uuid");
    // A rig number in the printed slug would let anyone check into any rig.
    expect(payload.qrToken).not.toContain("12");
  });

  it("names the rig after its number when staff do not", async () => {
    await POST(post({ rigNumber: 7 }));
    expect(rigInsert().params[1]).toBe("Rig 07");

    calls.length = 0;
    await POST(post({ rigNumber: 7, displayName: "  Sim by the door " }));
    expect(rigInsert().params[1]).toBe("Sim by the door");
  });

  it("answers 409 for a rig number already on the floor", async () => {
    insertError = Object.assign(new Error("duplicate"), { code: "23505" });

    const response = await POST(post({ rigNumber: 3 }));

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("rig_number_taken");
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("rejects a rig number that is not one of the venue's", async () => {
    for (const rigNumber of [0, -1, 1000, 2.5]) {
      expect((await POST(post({ rigNumber }))).status).toBe(400);
    }
    expect(client.query).not.toHaveBeenCalled();
  });

  it("audits the rig without putting its token in a table staff can read", async () => {
    const payload = await (await POST(post({ rigNumber: 5 }))).json();

    const entry = writeAudit.mock.calls[0]![0];
    expect(entry).toMatchObject({
      staffUserId: STAFF.userId,
      action: "create_rig",
      targetType: "rig",
      targetId: "rig-uuid",
    });
    expect(JSON.stringify(entry)).not.toContain(payload.agentToken);
    // The QR slug is printed on the machine, so recording it is what makes a
    // reprint possible.
    expect(entry.detail.qrToken).toBe(payload.qrToken);
  });

  it("does not put the token in the log when the insert fails", async () => {
    insertError = new Error("connection terminated");
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      logged.push(args);
    });

    const response = await POST(post({ rigNumber: 8 }));
    spy.mockRestore();

    expect(response.status).toBe(500);
    expect(JSON.stringify(logged)).not.toContain(AGENT_TOKEN_PREFIX);
  });
});
