import { queryOne } from "@/lib/db";
import { rigFromBearer } from "@/lib/agent-auth";

/**
 * Ends the rig's open assignment — the agent's "switch driver / sign out"
 * action. Agent-authed and scoped to the caller's own rig; laps on the closed
 * assignment are never touched.
 */
export async function POST(request: Request) {
  const rig = await rigFromBearer(request.headers.get("authorization"));
  if (!rig) return Response.json({ error: "unauthorized" }, { status: 401 });

  try {
    const ended = await queryOne<{ id: string }>(
      `update rig_assignments
       set ended_at = now(), end_reason = 'switched'
       where rig_id = $1 and ended_at is null
       returning id`,
      [rig.id],
    );
    // ended: false = no one was checked in.
    return Response.json({ ended: Boolean(ended) });
  } catch (error) {
    console.error("[agent/checkout] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
