import { serviceClient } from "@/lib/supabase";
import { rigFromBearer } from "@/lib/agent-auth";

/** Polling fallback for agents when the realtime channel drops. */
export async function GET(request: Request) {
  const db = serviceClient();
  const rig = await rigFromBearer(db, request.headers.get("authorization"));
  if (!rig) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { data } = await db
    .from("rig_assignments")
    .select("id, started_at, drivers ( id, display_name )")
    .eq("rig_id", rig.id)
    .is("ended_at", null)
    .maybeSingle();

  if (!data) return Response.json({ assignment: null });

  const driver = Array.isArray(data.drivers) ? data.drivers[0] : data.drivers;
  return Response.json({
    assignment: {
      id: data.id,
      startedAt: data.started_at,
      driver: { id: driver?.id, displayName: driver?.display_name },
    },
  });
}
