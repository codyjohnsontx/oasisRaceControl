import { z } from "zod";
import { queryOne } from "@/lib/db";
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

  try {
    const lap = await queryOne<{ id: string; is_valid: boolean }>(
      `update laps
       set is_valid = $2,
           invalid_reason = case when $2 then null else 'MANUALLY_INVALIDATED'::invalid_reason end
       where id = $1
       returning id, is_valid`,
      [input.lapId, !invalidate],
    );

    if (!lap) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    await writeAudit({
      staffUserId: staff.userId,
      action: invalidate ? "invalidate_lap" : "restore_lap",
      targetType: "lap",
      targetId: lap.id,
      reason: input.reason,
    });

    return Response.json({ lapId: lap.id, isValid: lap.is_valid });
  } catch (error) {
    console.error("[staff/lap-validity] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
