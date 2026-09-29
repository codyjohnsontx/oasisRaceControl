import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

/**
 * The staff PIN reset is how a returning racer whose PIN no longer matches
 * gets back in without a second name splitting their times. What must hold:
 * only staff can call it, a mistyped confirmation changes nothing, the new PIN
 * works and the old one stops working, the lockout goes with the old PIN, and
 * the audit row names who did it without ever holding the PIN.
 *
 * The same guarantees against real Postgres, through the driver login route,
 * are in route.integration.test.ts.
 */

const query = vi.fn();
const queryOne = vi.fn();
const writeAudit = vi.fn();
const getStaffUser = vi.fn();

vi.mock("@/lib/db", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  isUniqueViolation: () => false,
}));
vi.mock("@/lib/staff", () => ({
  getStaffUser: () => getStaffUser(),
  writeAudit: (...args: unknown[]) => writeAudit(...args),
}));

const { POST } = await import("./route");

const DRIVER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OLD_HASH = bcrypt.hashSync("1111", 4);

function post(body: unknown) {
  return new Request("http://localhost/api/staff/reset-pin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The pin_hash the update wrote, as the route passed it to the database. */
function storedHash(): string {
  const update = queryOne.mock.calls.find(([sql]) => String(sql).includes("update drivers"));
  return update![1][1] as string;
}

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  writeAudit.mockReset();
  getStaffUser.mockReset();
  getStaffUser.mockResolvedValue({ userId: "staff-uuid", displayName: "Cody" });
  queryOne.mockResolvedValue({ id: DRIVER_ID, display_name: "chuy" });
  query.mockResolvedValue([]);
});

describe("POST /api/staff/reset-pin", () => {
  it("refuses a caller with no staff session before touching the database", async () => {
    getStaffUser.mockResolvedValue(null);

    const response = await POST(post({ driverId: DRIVER_ID, newPin: "4321", confirmPin: "4321" }));

    expect(response.status).toBe(403);
    expect(queryOne).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("changes nothing when the two PINs differ", async () => {
    const response = await POST(post({ driverId: DRIVER_ID, newPin: "4321", confirmPin: "4312" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "pins_do_not_match" });
    expect(queryOne).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("changes nothing when the confirmation is missing", async () => {
    const response = await POST(post({ driverId: DRIVER_ID, newPin: "4321" }));

    expect(response.status).toBe(400);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it.each(["123", "12345", "12a4", ""])("refuses %j as a PIN", async (pin) => {
    const response = await POST(post({ driverId: DRIVER_ID, newPin: pin, confirmPin: pin }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_input" });
    expect(queryOne).not.toHaveBeenCalled();
  });

  it("404s a driver that does not exist, and audits nothing", async () => {
    queryOne.mockResolvedValue(null);

    const response = await POST(post({ driverId: DRIVER_ID, newPin: "4321", confirmPin: "4321" }));

    expect(response.status).toBe(404);
    expect(query).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("stores a hash the new PIN passes and the old PIN does not", async () => {
    expect(await bcrypt.compare("1111", OLD_HASH)).toBe(true);

    const response = await POST(post({ driverId: DRIVER_ID, newPin: "4321", confirmPin: "4321" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, displayName: "chuy" });
    const hash = storedHash();
    expect(hash).not.toBe(OLD_HASH);
    expect(await bcrypt.compare("4321", hash)).toBe(true);
    expect(await bcrypt.compare("1111", hash)).toBe(false);
    // Updated in place by id - the racer keeps the row their laps point at.
    expect(queryOne.mock.calls[0]![1][0]).toBe(DRIVER_ID);
  });

  it("clears the driver's PIN lockout", async () => {
    await POST(post({ driverId: DRIVER_ID, newPin: "4321", confirmPin: "4321" }));

    expect(query).toHaveBeenCalledWith("delete from pin_attempts where driver_id = $1", [
      DRIVER_ID,
    ]);
  });

  it("audits the staff member, the driver and the action, never the PIN", async () => {
    await POST(post({ driverId: DRIVER_ID, newPin: "4321", confirmPin: "4321" }));

    expect(writeAudit).toHaveBeenCalledTimes(1);
    const entry = writeAudit.mock.calls[0]![0];
    expect(entry).toEqual({
      staffUserId: "staff-uuid",
      action: "reset_pin",
      targetType: "driver",
      targetId: DRIVER_ID,
      detail: { displayName: "chuy" },
    });
    const written = JSON.stringify(entry);
    expect(written).not.toContain("4321");
    expect(written).not.toContain(storedHash());
  });
});
