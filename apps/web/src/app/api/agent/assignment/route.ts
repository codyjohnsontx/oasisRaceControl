import { queryOne } from "@/lib/db";
import { rigFromBearer } from "@/lib/agent-auth";

/** Polling fallback for agents; also their primary channel now that the
 * backend has no push transport. */
export async function GET(request: Request) {
  const rig = await rigFromBearer(request.headers.get("authorization"));
  if (!rig) return Response.json({ error: "unauthorized" }, { status: 401 });

  const row = await queryOne<{
    id: string;
    started_at: Date;
    driver_id: string;
    display_name: string;
  }>(
    `select ra.id, ra.started_at, d.id as driver_id, d.display_name
     from rig_assignments ra
     join drivers d on d.id = ra.driver_id
     where ra.rig_id = $1 and ra.ended_at is null`,
    [rig.id],
  );

  if (!row) return Response.json({ assignment: null });

  return Response.json({
    assignment: {
      id: row.id,
      startedAt: row.started_at,
      driver: { id: row.driver_id, displayName: row.display_name },
    },
  });
}
