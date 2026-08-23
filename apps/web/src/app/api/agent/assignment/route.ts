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

  // Which rig this token actually is, on every poll, whether or not anybody is
  // checked in. A rig's token is the whole of its identity here - the backend
  // credits laps to the rig the token names and has no other way of knowing
  // which computer sent them - so a machine installed with another rig's token
  // is scoring for somewhere else in the room while its own screen shows the
  // number that was typed into it. Nothing on this side can see that: the token
  // is valid, the laps are well formed, and rig 07 is where they belong as far
  // as the database is concerned. Only the machine knows which station it is
  // standing at, so the backend says who it thinks is asking and the agent
  // compares (apps/rig-agent/OasisRigAgent.Core/RigIdentity.cs).
  const identity = { number: rig.rig_number, displayName: rig.display_name };

  if (!row) return Response.json({ rig: identity, assignment: null });

  return Response.json({
    rig: identity,
    assignment: {
      id: row.id,
      startedAt: row.started_at,
      driver: { id: row.driver_id, displayName: row.display_name },
    },
  });
}
