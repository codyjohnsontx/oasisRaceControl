import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
import { setDriverSession } from "@/lib/driver-session";
import { parseJsonBody } from "@/lib/http";
import {
  displayNameSchema,
  pinSchema,
  verifyPin,
  checkLockout,
  recordPinFailure,
  clearPinFailures,
} from "@/lib/driver-auth";

const body = z.object({ displayName: displayNameSchema, pin: pinSchema });

// Compared against when no usable driver exists, so unknown names cost the
// same bcrypt work as wrong PINs — no name probing via response timing.
const DUMMY_PIN_HASH = "$2b$10$KWAPErVpVeGiV16GbCVpheKt9v50acLl2VRdevylCNm7B6L4SC7ni";

export async function POST(request: Request) {
  const input = await parseJsonBody(request, body);
  if (input instanceof Response) return input;

  const db = serviceClient();
  const { data: driver } = await db
    .from("drivers")
    .select("id, display_name, pin_hash, is_guest, status")
    .eq("display_name", input.displayName)
    .maybeSingle();

  // Same response (and same bcrypt timing) for unknown name and wrong PIN.
  if (!driver || !driver.pin_hash || driver.status === "banned") {
    await verifyPin(input.pin, DUMMY_PIN_HASH);
    return Response.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const lockedUntil = await checkLockout(db, driver.id);
  if (lockedUntil) {
    return Response.json({ error: "locked", lockedUntil }, { status: 429 });
  }

  if (!(await verifyPin(input.pin, driver.pin_hash))) {
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
