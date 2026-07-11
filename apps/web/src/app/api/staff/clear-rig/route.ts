import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
import { getStaffUser, writeAudit } from "@/lib/staff";
import { parseJsonBody } from "@/lib/http";

const body = z.object({ rigId: z.uuid(), reason: z.string().max(300).optional() });

export async function POST(request: Request) {
  const staff = await getStaffUser();
  if (!staff) return Response.json({ error: "forbidden" }, { status: 403 });

  const input = await parseJsonBody(request, body);
  if (input instanceof Response) return input;

  const db = serviceClient();
  const { data, error } = await db
    .from("rig_assignments")
    .update({ ended_at: new Date().toISOString(), end_reason: "staff_cleared" })
    .eq("rig_id", input.rigId)
    .is("ended_at", null)
    .select("id, driver_id")
    .maybeSingle();

  if (error) {
    return Response.json({ error: "server_error" }, { status: 500 });
  }

  if (data) {
    await writeAudit({
      staffUserId: staff.userId,
      action: "clear_rig",
      targetType: "rig_assignment",
      targetId: data.id,
      reason: input.reason,
      detail: { rigId: input.rigId, driverId: data.driver_id },
    });
  }

  // cleared: false = update succeeded but the rig had no open assignment.
  return Response.json({ cleared: Boolean(data) });
}
