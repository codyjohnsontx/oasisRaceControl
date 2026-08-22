import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A lap with no driver has no validity to argue about, and restoring one would
 * put an unrankable lap on a leaderboard under an empty name. The database
 * refuses it outright (laps_unattributed_is_invalid, db/migrations/0003); this
 * route is what turns that into an answer staff can read.
 */

const queryOne = vi.fn();
const writeAudit = vi.fn();
const getStaffUser = vi.fn();

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  queryOne: (...args: unknown[]) => queryOne(...args),
  isUniqueViolation: () => false,
}));
vi.mock("@/lib/staff", () => ({
  getStaffUser: () => getStaffUser(),
  writeAudit: (...args: unknown[]) => writeAudit(...args),
}));

const { POST } = await import("./route");

const LAP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function post(body: unknown) {
  return new Request("http://localhost/api/staff/lap-validity", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The lap row the pre-flight select finds, then the update's returning row. */
function lapWithDriver(driverId: string | null) {
  queryOne.mockImplementation(async (sql: string) => {
    if (sql.includes("select driver_id from laps")) return { driver_id: driverId };
    if (sql.includes("update laps")) return { id: LAP_ID, is_valid: true };
    return null;
  });
}

beforeEach(() => {
  queryOne.mockReset();
  writeAudit.mockReset();
  getStaffUser.mockReset();
  getStaffUser.mockResolvedValue({ userId: "staff-uuid", displayName: "Cody" });
});

describe("POST /api/staff/lap-validity", () => {
  it("refuses to restore a lap that has no driver", async () => {
    lapWithDriver(null);

    const response = await POST(
      post({ lapId: LAP_ID, action: "restore", reason: "customer asked" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "lap_is_unattributed" });
    // Nothing was written, and nothing was audited as though it had been.
    const updates = queryOne.mock.calls.filter(([sql]) =>
      String(sql).includes("update laps"),
    );
    expect(updates).toHaveLength(0);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("refuses to invalidate a lap that has no driver", async () => {
    lapWithDriver(null);

    // Already invalid for a better reason; overwriting it would lose why.
    const response = await POST(
      post({ lapId: LAP_ID, action: "invalidate", reason: "tidying up" }),
    );

    expect(response.status).toBe(409);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("still restores an ordinary lap", async () => {
    lapWithDriver("driver-uuid");

    const response = await POST(
      post({ lapId: LAP_ID, action: "restore", reason: "off-track was a replay glitch" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ lapId: LAP_ID, isValid: true });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "restore_lap", targetId: LAP_ID }),
    );
  });

  it("404s a lap that does not exist", async () => {
    queryOne.mockResolvedValue(null);

    const response = await POST(
      post({ lapId: LAP_ID, action: "restore", reason: "typo" }),
    );

    expect(response.status).toBe(404);
  });

  it("rejects an unauthenticated caller before touching the database", async () => {
    getStaffUser.mockResolvedValue(null);

    const response = await POST(
      post({ lapId: LAP_ID, action: "restore", reason: "nope" }),
    );

    expect(response.status).toBe(403);
    expect(queryOne).not.toHaveBeenCalled();
  });
});
