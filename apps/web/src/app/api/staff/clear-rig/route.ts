import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
import { getStaffUser, writeAudit } from "@/lib/staff";

const body = z.object({ rigId: z.uuid(), reason: z.string().max(300).optional() });

export async function POST(request: Request) {
  const staff = await getStaffUser();
  if (!staff) return Response.json({ error: "forbidden" }, { status: 403 });

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  const db = serviceClient();
  const { data } = await db
    .from("rig_assignments")
    .update({ ended_at: new Date().toISOString(), end_reason: "staff_cleared" })
    .eq("rig_id", parsed.data.rigId)
    .is("ended_at", null)
    .select("id, driver_id")
    .maybeSingle();

  if (data) {
    await writeAudit({
      staffUserId: staff.userId,
      action: "clear_rig",
      targetType: "rig_assignment",
      targetId: data.id,
      reason: parsed.data.reason,
      detail: { rigId: parsed.data.rigId, driverId: data.driver_id },
    });
  }

  return Response.json({ cleared: Boolean(data) });
}
