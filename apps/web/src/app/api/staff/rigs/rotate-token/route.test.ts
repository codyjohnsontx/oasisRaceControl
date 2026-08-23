import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentTokenHash } from "@/lib/agent-auth";
import { AGENT_TOKEN_PREFIX } from "@/lib/rig-enrolment";

/**
 * Revoking a rig's token. This is the venue's only answer to a token that has
 * leaked, been typed onto the wrong machine, or been lost — so the old one has
 * to stop working, and the new one has to be the only copy staff hold.
 */

type Call = { sql: string; params: unknown[] };
const calls: Call[] = [];
let updated: Record<string, unknown> | null = {
  id: "rig-uuid",
  rig_number: 7,
  display_name: "Rig 07",
};

const queryOne = vi.fn(async (sql: string, params: unknown[] = []) => {
  calls.push({ sql, params });
  return updated;
});

vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    ...actual,
    query: vi.fn(),
    queryOne: (...args: [string, unknown[]]) => queryOne(...args),
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
const RIG_ID = "11111111-1111-4111-8111-111111111111";

function post(body: unknown) {
  return new Request("http://localhost/api/staff/rigs/rotate-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  calls.length = 0;
  updated = { id: "rig-uuid", rig_number: 7, display_name: "Rig 07" };
  queryOne.mockClear();
  writeAudit.mockReset();
  getStaffUser.mockReset();
  getStaffUser.mockResolvedValue(STAFF);
});

describe("POST /api/staff/rigs/rotate-token", () => {
  it("refuses anyone who is not signed in as staff, before touching the database", async () => {
    getStaffUser.mockResolvedValue(null);

    const response = await POST(post({ rigId: RIG_ID }));

    expect(response.status).toBe(403);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it("replaces the stored hash with the hash of the token it hands back", async () => {
    const payload = await (await POST(post({ rigId: RIG_ID }))).json();

    expect(payload.agentToken).toMatch(/^oasisrig_[A-Za-z0-9_-]{43}$/);
    const update = calls[0]!;
    expect(update.sql).toContain("update rigs set agent_token_hash");
    expect(update.params).toEqual([RIG_ID, agentTokenHash(payload.agentToken)]);
    expect(JSON.stringify(calls)).not.toContain(payload.agentToken);
  });

  it("answers 404 for a rig that is not there, and audits nothing", async () => {
    updated = null;

    const response = await POST(post({ rigId: RIG_ID }));

    expect(response.status).toBe(404);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("audits the rotation with its reason and without the token", async () => {
    const payload = await (
      await POST(post({ rigId: RIG_ID, reason: "pasted into the group chat" }))
    ).json();

    const entry = writeAudit.mock.calls[0]![0];
    expect(entry).toMatchObject({
      action: "rotate_rig_token",
      targetType: "rig",
      targetId: "rig-uuid",
      reason: "pasted into the group chat",
    });
    expect(JSON.stringify(entry)).not.toContain(payload.agentToken);
  });

  it("rejects a body that does not name one rig", async () => {
    for (const body of [{}, { rigId: "" }, { rigId: "rig-7" }]) {
      expect((await POST(post(body))).status).toBe(400);
    }
    expect(queryOne).not.toHaveBeenCalled();
  });

  it("does not put the token in the log when the update fails", async () => {
    queryOne.mockRejectedValueOnce(new Error("connection terminated"));
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      logged.push(args);
    });

    const response = await POST(post({ rigId: RIG_ID }));
    spy.mockRestore();

    expect(response.status).toBe(500);
    expect(JSON.stringify(logged)).not.toContain(AGENT_TOKEN_PREFIX);
  });
});
