import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
import { setDriverSession } from "@/lib/driver-session";
import {
  displayNameSchema,
  pinSchema,
  verifyPin,
  checkLockout,
  recordPinFailure,
  clearPinFailures,
} from "@/lib/driver-auth";

const body = z.object({ displayName: displayNameSchema, pin: pinSchema });

export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  const db = serviceClient();
  const { data: driver } = await db
    .from("drivers")
    .select("id, display_name, pin_hash, is_guest, status")
    .eq("display_name", parsed.data.displayName)
    .maybeSingle();

  // Same response for unknown name and wrong PIN — no name probing.
  if (!driver || !driver.pin_hash || driver.status === "banned") {
    return Response.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const lockedUntil = await checkLockout(db, driver.id);
  if (lockedUntil) {
    return Response.json({ error: "locked", lockedUntil }, { status: 429 });
  }

  if (!(await verifyPin(parsed.data.pin, driver.pin_hash))) {
    await recordPinFailure(db, driver.id);
    return Response.json({ error: "invalid_credentials" }, { status: 401 });
  }

  await clearPinFailures(db, driver.id);
  await setDriverSession({
    driverId: driver.id,
    displayName: driver.display_name,
    isGuest: false,
  });
  return Response.json({ driverId: driver.id, displayName: driver.display_name });
}
