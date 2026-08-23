import { z } from "zod";
import { getStaffUser, writeAudit } from "@/lib/staff";
import { parseJsonBody } from "@/lib/http";
import { rotateAgentToken } from "@/lib/rig-enrolment";

const body = z.object({
  rigId: z.uuid(),
  reason: z.string().max(300).optional(),
});

/**
 * Revokes a rig's bearer token and issues a new one, returned once.
 *
 * The old token stops being accepted immediately — that is the point of the
 * call, and it is why the machine at that rig reads `⛔ TOKEN REFUSED` until it
 * is re-enrolled. Laps it has already queued are held, not lost, and deliver
 * themselves once the new token is installed.
 */
export async function POST(request: Request) {
  const staff = await getStaffUser();
  if (!staff) return Response.json({ error: "forbidden" }, { status: 403 });

  const input = await parseJsonBody(request, body);
  if (input instanceof Response) return input;

  try {
    const rig = await rotateAgentToken(input.rigId);
    if (!rig) return Response.json({ error: "not_found" }, { status: 404 });

    await writeAudit({
      staffUserId: staff.userId,
      action: "rotate_rig_token",
      targetType: "rig",
      targetId: rig.id,
      reason: input.reason,
      detail: { rigNumber: rig.rigNumber },
    });

    return Response.json({
      rig: { id: rig.id, rigNumber: rig.rigNumber, displayName: rig.displayName },
      agentToken: rig.agentToken,
    });
  } catch (error) {
    console.error("[staff/rigs/rotate-token] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
