import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
import { getStaffUser, writeAudit } from "@/lib/staff";
import { parseJsonBody } from "@/lib/http";

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

  const input = await parseJsonBody(request, body);
  if (input instanceof Response) return input;

  const invalidate = input.action === "invalidate";
  const db = serviceClient();
  const { data, error } = await db
    .from("laps")
    .update({
      is_valid: !invalidate,
      invalid_reason: invalidate ? "MANUALLY_INVALIDATED" : null,
    })
    .eq("id", input.lapId)
    .select("id, is_valid")
    .maybeSingle();

  if (error) {
    return Response.json({ error: "server_error" }, { status: 500 });
  }
  if (!data) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  await writeAudit({
    staffUserId: staff.userId,
    action: invalidate ? "invalidate_lap" : "restore_lap",
    targetType: "lap",
    targetId: data.id,
    reason: input.reason,
  });

  return Response.json({ lapId: data.id, isValid: data.is_valid });
}
