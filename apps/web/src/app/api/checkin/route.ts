import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
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

  const db = serviceClient();

  const { data: qr } = await db
    .from("rig_qr_tokens")
    .select("rig_id, active, rigs ( id, rig_number, display_name )")
    .eq("token", input.qrToken)
    .maybeSingle();
  const rig = Array.isArray(qr?.rigs) ? qr?.rigs[0] : qr?.rigs;
  if (!qr?.active || !rig) {
    return Response.json({ error: "unknown_rig" }, { status: 404 });
  }

  const { data: driver } = await db
    .from("drivers")
    .select("id, status")
    .eq("id", session.driverId)
    .maybeSingle();
  if (!driver || driver.status === "banned") {
    return Response.json({ error: "not_allowed" }, { status: 403 });
  }

  const { data, error } = await db.rpc("checkin_driver", {
    p_driver_id: session.driverId,
    p_rig_id: qr.rig_id,
    p_confirm_move: input.confirmMove ?? false,
    p_confirm_takeover: input.confirmTakeover ?? false,
  });

  if (error) {
    // Unique-index race (two phones committing simultaneously): ask to retry.
    if (error.code === "23505") {
      return Response.json({ error: "conflict_retry" }, { status: 409 });
    }
    return Response.json({ error: "server_error" }, { status: 500 });
  }

  return Response.json({ ...data, rig });
}
