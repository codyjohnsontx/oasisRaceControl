import { z } from "zod";
import { queryOne } from "@/lib/db";
import { getStaffUser, writeAudit } from "@/lib/staff";
import { parseJsonBody } from "@/lib/http";
import { pinSchema, hashPin, clearPinFailures } from "@/lib/driver-auth";

const body = z.object({ driverId: z.uuid(), newPin: pinSchema });

/** Display-name-only identity means no self-service recovery — staff PIN
 * reset is the recovery path (discovery decision). */
export async function POST(request: Request) {
  const staff = await getStaffUser();
  if (!staff) return Response.json({ error: "forbidden" }, { status: 403 });

  const input = await parseJsonBody(request, body);
  if (input instanceof Response) return input;

  try {
    const driver = await queryOne<{ id: string }>(
      `update drivers
       set pin_hash = $2, is_guest = false, updated_at = now()
       where id = $1
       returning id`,
      [input.driverId, await hashPin(input.newPin)],
    );

    if (!driver) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    await clearPinFailures(driver.id);
    await writeAudit({
      staffUserId: staff.userId,
      action: "reset_pin",
      targetType: "driver",
      targetId: driver.id,
    });

    return Response.json({ ok: true });
  } catch (error) {
    console.error("[staff/reset-pin] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
