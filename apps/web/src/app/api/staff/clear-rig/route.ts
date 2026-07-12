import { z } from "zod";
import { queryOne } from "@/lib/db";
import { getStaffUser, writeAudit } from "@/lib/staff";
import { parseJsonBody } from "@/lib/http";

const body = z.object({ rigId: z.uuid(), reason: z.string().max(300).optional() });

export async function POST(request: Request) {
  const staff = await getStaffUser();
  if (!staff) return Response.json({ error: "forbidden" }, { status: 403 });

  const input = await parseJsonBody(request, body);
  if (input instanceof Response) return input;

  try {
    const cleared = await queryOne<{ id: string; driver_id: string }>(
      `update rig_assignments
       set ended_at = now(), end_reason = 'staff_cleared'
       where rig_id = $1 and ended_at is null
       returning id, driver_id`,
      [input.rigId],
    );

    if (cleared) {
      await writeAudit({
        staffUserId: staff.userId,
        action: "clear_rig",
        targetType: "rig_assignment",
        targetId: cleared.id,
        reason: input.reason,
        detail: { rigId: input.rigId, driverId: cleared.driver_id },
      });
    }

    // cleared: false = update succeeded but the rig had no open assignment.
    return Response.json({ cleared: Boolean(cleared) });
  } catch (error) {
    console.error("[staff/clear-rig] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
