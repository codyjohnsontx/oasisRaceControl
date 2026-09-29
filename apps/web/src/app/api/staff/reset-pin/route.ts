import { z } from "zod";
import { queryOne } from "@/lib/db";
import { getStaffUser, writeAudit } from "@/lib/staff";
import { pinSchema, hashPin, clearPinFailures } from "@/lib/driver-auth";

// The PIN arrives twice because staff type it on the racer's say-so, and a
// mistyped reset is the same lock-out it was meant to fix. Checked here as
// well as in the form so no caller can skip it.
const body = z
  .object({ driverId: z.uuid(), newPin: pinSchema, confirmPin: z.string() })
  .refine((input) => input.newPin === input.confirmPin, { path: ["confirmPin"] });

/** Display-name-only identity means no self-service recovery - staff PIN
 * reset is the recovery path (discovery decision). The driver row keeps its id,
 * so every lap they have driven stays theirs. */
export async function POST(request: Request) {
  const staff = await getStaffUser();
  if (!staff) return Response.json({ error: "forbidden" }, { status: 403 });

  const raw = await request.json().catch(() => null);
  const parsed = body.safeParse(raw);
  if (!parsed.success) {
    const mismatch = parsed.error.issues.some((issue) => issue.path[0] === "confirmPin");
    return Response.json(
      { error: mismatch ? "pins_do_not_match" : "invalid_input" },
      { status: 400 },
    );
  }
  const input = parsed.data;

  try {
    const driver = await queryOne<{ id: string; display_name: string }>(
      `update drivers
       set pin_hash = $2, is_guest = false, updated_at = now()
       where id = $1
       returning id, display_name`,
      [input.driverId, await hashPin(input.newPin)],
    );

    if (!driver) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    // A racer locked out by their own wrong guesses would otherwise stay
    // locked for up to 15 minutes after staff gave them a PIN that works.
    await clearPinFailures(driver.id);
    // Who and when come from the row itself (staff_user_id, created_at). The
    // PIN - new or old - is never written anywhere but as the bcrypt hash.
    await writeAudit({
      staffUserId: staff.userId,
      action: "reset_pin",
      targetType: "driver",
      targetId: driver.id,
      detail: { displayName: driver.display_name },
    });

    return Response.json({ ok: true, displayName: driver.display_name });
  } catch (error) {
    console.error("[staff/reset-pin] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
