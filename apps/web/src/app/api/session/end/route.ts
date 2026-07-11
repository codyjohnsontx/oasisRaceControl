import { serviceClient } from "@/lib/supabase";
import { getDriverSession } from "@/lib/driver-session";

export async function POST() {
  const session = await getDriverSession();
  if (!session) return Response.json({ error: "not_signed_in" }, { status: 401 });

  const db = serviceClient();
  const { data } = await db
    .from("rig_assignments")
    .update({ ended_at: new Date().toISOString(), end_reason: "driver_ended" })
    .eq("driver_id", session.driverId)
    .is("ended_at", null)
    .select("id")
    .maybeSingle();

  return Response.json({ ended: Boolean(data) });
}
