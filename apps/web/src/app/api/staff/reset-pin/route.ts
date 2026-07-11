import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
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

  const db = serviceClient();
  const { data, error } = await db
    .from("drivers")
    .update({
      pin_hash: await hashPin(input.newPin),
      is_guest: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.driverId)
    .select("id")
    .maybeSingle();

  if (error) {
    return Response.json({ error: "server_error" }, { status: 500 });
  }
  if (!data) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  await clearPinFailures(db, data.id);
  await writeAudit({
    staffUserId: staff.userId,
    action: "reset_pin",
    targetType: "driver",
    targetId: data.id,
  });

  return Response.json({ ok: true });
}
