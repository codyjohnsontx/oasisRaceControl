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
const withTransaction = vi.fn();
const getStaffUser = vi.fn();

vi.mock("@/lib/db", () => ({
  withTransaction: (fn: unknown) => withTransaction(fn),
}));
vi.mock("@/lib/staff", () => ({
  getStaffUser: () => getStaffUser(),
}));

const { POST } = await import("./route");

const DRIVER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OLD_HASH = bcrypt.hashSync("1111", 4);

/** A request as the staff page's own fetch sends it: same origin, JSON. */
function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/staff/reset-pin", {
    method: "POST",
    headers: {
      host: "localhost",
      origin: "http://localhost",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** Every statement the route ran inside its transaction. */
function statements(): Array<[string, unknown[]]> {
  return query.mock.calls.map(([sql, params]) => [String(sql), params as unknown[]]);
}

/** The pin_hash the update wrote, as the route passed it to the database. */
function storedHash(): string {
  return statements().find(([sql]) => sql.includes("update drivers"))![1][1] as string;
}

/** The audit_log insert's parameters. */
function auditParams(): unknown[][] {
  return statements()
    .filter(([sql]) => sql.includes("insert into audit_log"))
    .map(([, params]) => params);
}

beforeEach(() => {
  query.mockReset();
  withTransaction.mockReset();
  getStaffUser.mockReset();
  getStaffUser.mockResolvedValue({ userId: "staff-uuid", displayName: "Cody" });
  query.mockImplementation(async (sql: string) =>
    sql.includes("update drivers")
      ? { rows: [{ id: DRIVER_ID, display_name: "chuy" }] }
      : { rows: [] },
  );
  withTransaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) =>
    fn({ query }),
  );
});

describe("POST /api/staff/reset-pin", () => {
  // This resets a credential, and the staff cookie is SameSite=Lax - which
  // keeps it off other sites' requests but not off another origin on the same
  // site. Each of these is refused before the session is even looked up.
  it.each([
    ["a foreign origin", { origin: "https://evil.example" }],
    ["another origin on the same site", { origin: "http://staff-tools.localhost" }],
    ["an opaque null origin", { origin: "null" }],
    ["a text/plain form post", { "content-type": "text/plain" }],
    ["a url-encoded form post", { "content-type": "application/x-www-form-urlencoded" }],
  ])("refuses %s before looking at the session", async (_label, headers) => {
    const response = await POST(
      post({ driverId: DRIVER_ID, newPin: "4321", confirmPin: "4321" }, headers),
    );

    expect([403, 415]).toContain(response.status);
    expect(getStaffUser).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("refuses a request with no Origin header at all", async () => {
    const request = new Request("http://localhost/api/staff/reset-pin", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ driverId: DRIVER_ID, newPin: "4321", confirmPin: "4321" }),
    });

    const response = await POST(request);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "cross_origin" });
    expect(getStaffUser).not.toHaveBeenCalled();
  });

  it("names why a cross-origin request and a form post were refused", async () => {
    const foreign = await POST(
      post({ driverId: DRIVER_ID, newPin: "4321", confirmPin: "4321" }, {
        origin: "https://evil.example",
      }),
    );
    expect(foreign.status).toBe(403);
    await expect(foreign.json()).resolves.toEqual({ error: "cross_origin" });

    const form = await POST(
      post({ driverId: DRIVER_ID, newPin: "4321", confirmPin: "4321" }, {
        "content-type": "text/plain;charset=UTF-8",
      }),
    );
    expect(form.status).toBe(415);
    await expect(form.json()).resolves.toEqual({ error: "unsupported_media_type" });
  });

  // Under `next start` and the standalone server, request.url carries the bind
  // address, not the one staff typed - the event laptop's LAN IP, or the kind
  // cluster's forwarded port.
  it.each([
    ["a LAN address", { host: "192.168.1.20:3000" }, "http://192.168.1.20:3000"],
    ["a forwarded port", { host: "localhost:8080" }, "http://localhost:8080"],
    [
      "a proxy's forwarded host",
      { host: "10.0.0.5:3000", "x-forwarded-host": "oasis.example" },
      "https://oasis.example",
    ],
  ])("accepts the staff page opened on %s", async (_label, hostHeaders, origin) => {
    const request = new Request("http://0.0.0.0:3000/api/staff/reset-pin", {
      method: "POST",
      headers: { ...hostHeaders, origin, "content-type": "application/json" },
      body: JSON.stringify({ driverId: DRIVER_ID, newPin: "4321", confirmPin: "4321" }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(withTransaction).toHaveBeenCalledTimes(1);
  });

  it("refuses an origin that matches the Host but not the forwarded host", async () => {
    const response = await POST(
      post({ driverId: DRIVER_ID, newPin: "4321", confirmPin: "4321" }, {
        "x-forwarded-host": "oasis.example",
      }),
    );

    expect(response.status).toBe(403);
    expect(getStaffUser).not.toHaveBeenCalled();
  });

  it("accepts the staff page's own JSON request, charset and all", async () => {
    const response = await POST(
      post({ driverId: DRIVER_ID, newPin: "4321", confirmPin: "4321" }, {
        "content-type": "application/json; charset=utf-8",
      }),
    );

    expect(response.status).toBe(200);
    expect(withTransaction).toHaveBeenCalledTimes(1);
  });

  it("refuses a caller with no staff session before touching the database", async () => {
    getStaffUser.mockResolvedValue(null);

    const response = await POST(post({ driverId: DRIVER_ID, newPin: "4321", confirmPin: "4321" }));

    expect(response.status).toBe(403);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("changes nothing when the two PINs differ", async () => {
    const response = await POST(post({ driverId: DRIVER_ID, newPin: "4321", confirmPin: "4312" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "pins_do_not_match" });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("changes nothing when the confirmation is missing", async () => {
    const response = await POST(post({ driverId: DRIVER_ID, newPin: "4321" }));

    expect(response.status).toBe(400);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it.each(["123", "12345", "12a4", ""])("refuses %j as a PIN", async (pin) => {
    const response = await POST(post({ driverId: DRIVER_ID, newPin: pin, confirmPin: pin }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_input" });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("404s a driver that does not exist, and audits nothing", async () => {
    query.mockResolvedValue({ rows: [] });

    const response = await POST(post({ driverId: DRIVER_ID, newPin: "4321", confirmPin: "4321" }));

    expect(response.status).toBe(404);
    expect(statements()).toHaveLength(1);
    expect(auditParams()).toHaveLength(0);
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
    expect(statements()[0]![1][0]).toBe(DRIVER_ID);
  });

  it("clears the driver's PIN lockout", async () => {
    await POST(post({ driverId: DRIVER_ID, newPin: "4321", confirmPin: "4321" }));

    expect(statements()).toContainEqual([
      "delete from pin_attempts where driver_id = $1",
      [DRIVER_ID],
    ]);
  });

  it("audits the staff member, the driver and the action, never the PIN", async () => {
    await POST(post({ driverId: DRIVER_ID, newPin: "4321", confirmPin: "4321" }));

    expect(auditParams()).toEqual([["staff-uuid", DRIVER_ID, { displayName: "chuy" }]]);
    const written = JSON.stringify(auditParams());
    expect(written).not.toContain("4321");
    expect(written).not.toContain(storedHash());
  });

  it("reports a failure, not a reset, when the audit row cannot be written", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("insert into audit_log")) throw new Error("audit insert failed");
      return sql.includes("update drivers")
        ? { rows: [{ id: DRIVER_ID, display_name: "chuy" }] }
        : { rows: [] };
    });

    const response = await POST(post({ driverId: DRIVER_ID, newPin: "4321", confirmPin: "4321" }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "server_error" });
  });
});
