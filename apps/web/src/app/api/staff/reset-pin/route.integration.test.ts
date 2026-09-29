import { afterAll, beforeEach, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import {
  closeTestDb,
  describeDb,
  lapRows,
  openAssignment,
  resetDb,
  seedRig,
  testDb,
} from "@/test/db";

/**
 * The staff PIN reset against real Postgres, judged the way the racer meets
 * it: through the driver sign-in route. A racer locked out after guessing at a
 * PIN that no longer matches is reset by staff, signs in with the new PIN (so
 * the lockout went too), cannot sign in with the old one, still owns every lap,
 * and the audit_log row says which staff member did it and when.
 *
 * Only the two cookie readers are mocked: the staff session (so a test can be
 * staff or not) and the driver session a successful sign-in would set.
 */

let staffUser: { userId: string; displayName: string } | null = null;

vi.mock("@/lib/staff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/staff")>()),
  getStaffUser: async () => staffUser,
}));
vi.mock("@/lib/driver-session", () => ({
  setDriverSession: async () => undefined,
}));

const { POST: resetPin } = await import("./route");
const { GET: findDrivers } = await import("../drivers/route");
const { POST: signIn } = await import("../../auth/login/route");

async function seedStaff(): Promise<{ userId: string; displayName: string }> {
  const { rows } = await testDb().query<{ id: string }>(
    `insert into staff_users (email, password_hash, display_name)
     values ('counter@example.com', 'not-a-real-hash', 'Counter Staff') returning id`,
  );
  return { userId: rows[0]!.id, displayName: "Counter Staff" };
}

async function seedRacer(name: string, pin: string): Promise<string> {
  const { rows } = await testDb().query<{ id: string }>(
    `insert into drivers (display_name, is_guest, pin_hash)
     values ($1, false, $2) returning id`,
    [name, bcrypt.hashSync(pin, 4)],
  );
  return rows[0]!.id;
}

async function seedLap(rigId: string, driverId: string): Promise<void> {
  const assignmentId = await openAssignment(rigId, driverId);
  await testDb().query(
    `insert into laps (event_id, rig_id, rig_assignment_id, driver_id,
                       track_name, car_name, lap_time_ms, is_valid, completed_at)
     values ('evt-chuy-1', $1, $2, $3, 'Spa-Francorchamps', 'Porsche 911 GT3 R',
             138000, true, now() - interval '1 day')`,
    [rigId, assignmentId, driverId],
  );
}

function signInWith(displayName: string, pin: string) {
  return signIn(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ displayName, pin }),
    }),
  );
}

function reset(driverId: string, newPin: string, confirmPin = newPin) {
  return resetPin(
    new Request("http://localhost/api/staff/reset-pin", {
      method: "POST",
      body: JSON.stringify({ driverId, newPin, confirmPin }),
    }),
  );
}

async function auditRows() {
  const { rows } = await testDb().query(
    `select staff_user_id, action, target_type, target_id, reason, detail, created_at
     from audit_log order by id`,
  );
  return rows;
}

describeDb("POST /api/staff/reset-pin against real Postgres", () => {
  beforeEach(async () => {
    staffUser = null;
    await resetDb();
  });
  afterAll(closeTestDb);

  it("gets a locked-out racer back in on a new PIN and logs who did it", async () => {
    const staff = await seedStaff();
    const rig = await seedRig(1);
    const chuy = await seedRacer("chuy", "1111");
    await seedLap(rig.id, chuy);

    // The racer guesses at the PIN they think they set until the lockout bites.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await signInWith("chuy", "2222")).status).toBe(401);
    }
    expect((await signInWith("chuy", "1111")).status).toBe(429);

    staffUser = staff;
    const before = new Date();
    const response = await reset(chuy, "4321");
    expect(response.status).toBe(200);

    const { rows: attempts } = await testDb().query(
      "select * from pin_attempts where driver_id = $1",
      [chuy],
    );
    expect(attempts).toHaveLength(0);

    // Straight in on the new PIN - no lockout left over - and not on the old.
    expect((await signInWith("chuy", "4321")).status).toBe(200);
    expect((await signInWith("chuy", "1111")).status).toBe(401);
    // Display names are citext, so the racer's capitalisation does not matter.
    expect((await signInWith("Chuy", "4321")).status).toBe(200);

    // Same driver row, so the lap is still theirs.
    const laps = await lapRows();
    expect(laps).toHaveLength(1);
    expect(laps[0]!.driver_id).toBe(chuy);

    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      staff_user_id: staff.userId,
      action: "reset_pin",
      target_type: "driver",
      target_id: chuy,
      detail: { displayName: "chuy" },
    });
    expect(new Date(audit[0]!.created_at).getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );
    const { rows: stored } = await testDb().query<{ pin_hash: string }>(
      "select pin_hash from drivers where id = $1",
      [chuy],
    );
    const written = JSON.stringify(audit[0]);
    expect(written).not.toContain("4321");
    expect(written).not.toContain(stored[0]!.pin_hash);
  });

  it("refuses a caller who is not staff and leaves the PIN alone", async () => {
    const chuy = await seedRacer("chuy", "1111");

    const response = await reset(chuy, "4321");

    expect(response.status).toBe(403);
    expect((await signInWith("chuy", "1111")).status).toBe(200);
    expect((await signInWith("chuy", "4321")).status).toBe(401);
    expect(await auditRows()).toHaveLength(0);
  });

  it("leaves the PIN alone when the confirmation does not match", async () => {
    staffUser = await seedStaff();
    const chuy = await seedRacer("chuy", "1111");

    const response = await reset(chuy, "4321", "4312");

    expect(response.status).toBe(400);
    expect((await signInWith("chuy", "1111")).status).toBe(200);
    expect(await auditRows()).toHaveLength(0);
  });

  it("finds the racer by part of their name, whatever the case, with their laps and lockout", async () => {
    staffUser = await seedStaff();
    const rig = await seedRig(1);
    const chuy = await seedRacer("chuy", "1111");
    await seedRacer("chuy2", "9999");
    await seedRacer("Achuy", "7777");
    await seedRacer("Somebody Else", "5555");
    await seedLap(rig.id, chuy);
    for (let attempt = 0; attempt < 5; attempt += 1) await signInWith("chuy", "2222");

    const response = await findDrivers(
      new Request("http://localhost/api/staff/drivers?name=CHU"),
    );

    expect(response.status).toBe(200);
    const { drivers } = (await response.json()) as {
      drivers: Array<{ display_name: string; lap_count: number; locked_until: string | null }>;
    };
    expect(drivers.map((driver) => driver.display_name)).toEqual(["Achuy", "chuy", "chuy2"]);
    expect(drivers[1]).toMatchObject({ lap_count: 1 });
    expect(drivers[1]!.locked_until).not.toBeNull();
    expect(drivers[2]).toMatchObject({ lap_count: 0, locked_until: null });

    // The name typed in full sorts first, ahead of names that merely contain it.
    const exact = await findDrivers(
      new Request("http://localhost/api/staff/drivers?name=Chuy"),
    );
    const exactBody = (await exact.json()) as { drivers: Array<{ display_name: string }> };
    expect(exactBody.drivers.map((driver) => driver.display_name)).toEqual([
      "chuy",
      "Achuy",
      "chuy2",
    ]);
  });
});
