import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
import { getStaffUser, writeAudit } from "@/lib/staff";

const body = z.object({
  lapId: z.uuid(),
  action: z.enum(["invalidate", "restore"]),
  reason: z.string().min(1).max(300),
});

/** Invalidate or restore a lap. Laps are never deleted — validity flips with
 * an audit trail so competition disputes stay resolvable. */
export async function POST(request: Request) {
  const staff = await getStaffUser();
  if (!staff) return Response.json({ error: "forbidden" }, { status: 403 });

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  const invalidate = parsed.data.action === "invalidate";
  const db = serviceClient();
  const { data, error } = await db
    .from("laps")
    .update({
      is_valid: !invalidate,
      invalid_reason: invalidate ? "MANUALLY_INVALIDATED" : null,
    })
    .eq("id", parsed.data.lapId)
    .select("id, is_valid")
    .maybeSingle();

  if (error || !data) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  await writeAudit({
    staffUserId: staff.userId,
    action: invalidate ? "invalidate_lap" : "restore_lap",
    targetType: "lap",
    targetId: data.id,
    reason: parsed.data.reason,
  });

  return Response.json({ lapId: data.id, isValid: data.is_valid });
}
