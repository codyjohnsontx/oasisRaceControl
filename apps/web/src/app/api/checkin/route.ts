import { z } from "zod";
import { queryOne, isUniqueViolation } from "@/lib/db";
import { getDriverSession } from "@/lib/driver-session";
import { parseJsonBody } from "@/lib/http";

const body = z.object({
  qrToken: z.string().min(1).max(120),
  confirmMove: z.boolean().optional(),
  confirmTakeover: z.boolean().optional(),
});

/**
 * Two-step check-in: without confirm flags this returns any conflicts the UI
 * must confirm (move rigs? take over from a finished driver?). With the flags
 * set, the checkin_driver Postgres function commits atomically. Laps on closed
 * assignments are never touched.
 */
export async function POST(request: Request) {
  const session = await getDriverSession();
  if (!session) return Response.json({ error: "not_signed_in" }, { status: 401 });

  const input = await parseJsonBody(request, body);
  if (input instanceof Response) return input;

  try {
    const rig = await queryOne<{
      rig_id: string;
      rig_number: number;
      display_name: string;
    }>(
      `select r.id as rig_id, r.rig_number, r.display_name
       from rig_qr_tokens t
       join rigs r on r.id = t.rig_id
       where t.token = $1 and t.active`,
      [input.qrToken],
    );
    if (!rig) {
      return Response.json({ error: "unknown_rig" }, { status: 404 });
    }

    const driver = await queryOne<{ status: string }>(
      "select status from drivers where id = $1",
      [session.driverId],
    );
    if (!driver || driver.status === "banned") {
      return Response.json({ error: "not_allowed" }, { status: 403 });
    }

    const result = await queryOne<{ result: Record<string, unknown> }>(
      "select checkin_driver($1, $2, $3, $4) as result",
      [
        session.driverId,
        rig.rig_id,
        input.confirmMove ?? false,
        input.confirmTakeover ?? false,
      ],
    );

    return Response.json({
      ...result?.result,
      rig: { id: rig.rig_id, rig_number: rig.rig_number, display_name: rig.display_name },
    });
  } catch (error) {
    // Unique-index race (two phones committing simultaneously): ask to retry.
    if (isUniqueViolation(error)) {
      return Response.json({ error: "conflict_retry" }, { status: 409 });
    }
    console.error("[checkin] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
