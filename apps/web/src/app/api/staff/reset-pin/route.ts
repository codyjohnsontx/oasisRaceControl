import { z } from "zod";
import { withTransaction } from "@/lib/db";
import { getStaffUser } from "@/lib/staff";
import { pinSchema, hashPin } from "@/lib/driver-auth";

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
    const pinHash = await hashPin(input.newPin);
    const driver = await withTransaction(async (client) => {
      const updated = await client.query<{ id: string; display_name: string }>(
        `update drivers
         set pin_hash = $2, is_guest = false, updated_at = now()
         where id = $1
         returning id, display_name`,
        [input.driverId, pinHash],
      );
      const row = updated.rows[0];
      if (!row) return null;

      // A racer locked out by their own wrong guesses would otherwise stay
      // locked for up to 15 minutes after staff gave them a PIN that works.
      await client.query("delete from pin_attempts where driver_id = $1", [row.id]);
      // Who and when come from the row itself (staff_user_id, created_at). The
      // PIN - new or old - is never written anywhere but as the bcrypt hash.
      await client.query(
        `insert into audit_log (staff_user_id, action, target_type, target_id, detail)
         values ($1, 'reset_pin', 'driver', $2, $3)`,
        [staff.userId, row.id, { displayName: row.display_name }],
      );
      return row;
    });

    if (!driver) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    return Response.json({ ok: true, displayName: driver.display_name });
  } catch (error) {
    console.error("[staff/reset-pin] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
