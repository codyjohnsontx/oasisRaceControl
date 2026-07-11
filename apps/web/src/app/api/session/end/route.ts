import { serviceClient } from "@/lib/supabase";
import { getDriverSession } from "@/lib/driver-session";

export async function POST() {
  const session = await getDriverSession();
  if (!session) return Response.json({ error: "not_signed_in" }, { status: 401 });

  const db = serviceClient();
  const { data, error } = await db
    .from("rig_assignments")
    .update({ ended_at: new Date().toISOString(), end_reason: "driver_ended" })
    .eq("driver_id", session.driverId)
    .is("ended_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    return Response.json({ error: "server_error" }, { status: 500 });
  }
  // ended: false = the update succeeded but there was no open assignment.
  return Response.json({ ended: Boolean(data) });
}
