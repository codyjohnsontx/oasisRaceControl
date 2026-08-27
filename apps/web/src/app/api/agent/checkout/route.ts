import { z } from "zod";
import { queryOne } from "@/lib/db";
import { rigFromBearer } from "@/lib/agent-auth";

const body = z.object({
  /**
   * Which stint to end. The agent sends this so the call can be repeated
   * safely: a switch-driver it could not deliver at the time is re-sent when
   * the venue link returns, and by then the seat may legitimately belong to the
   * next driver. Naming the assignment means a late retry closes the stint it
   * was pressed for or nothing at all - never somebody else's.
   *
   * Optional, because the agent cannot name a stint it has never been told
   * about: a rig PC that has not yet completed an assignment poll still has a
   * working button, and for it this means what it has always meant - end
   * whatever is open on this rig.
   */
  assignmentId: z.string().uuid().optional(),
});

/**
 * Ends one of the rig's assignments - the agent's "switch driver / sign out"
 * action. Agent-authed and scoped to the caller's own rig; laps on the closed
 * assignment are never touched.
 */
export async function POST(request: Request) {
  const rig = await rigFromBearer(request.headers.get("authorization"));
  if (!rig) return Response.json({ error: "unauthorized" }, { status: 401 });

  // No body at all is the unqualified form - that is what every agent before
  // this sent - so an empty request parses as {} rather than as a bad one.
  const raw = (await request.text()).trim();
  let payload: unknown = {};
  try {
    if (raw) payload = JSON.parse(raw);
  } catch {
    // Deliberately not lenient: a body that does not parse must not fall
    // through to the unqualified form and close whoever happens to be there.
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }
  const input = body.safeParse(payload);
  if (!input.success) {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  try {
    const ended = await queryOne<{ id: string }>(
      `update rig_assignments
       set ended_at = now(), end_reason = 'switched'
       where rig_id = $1 and ended_at is null
         and ($2::uuid is null or id = $2::uuid)
       returning id`,
      [rig.id, input.data.assignmentId ?? null],
    );
    // ended: false = there was nothing to close - nobody was checked in, or the
    // named stint has already ended some other way. A retry that gets this
    // answer is finished, not failed.
    return Response.json({ ended: Boolean(ended) });
  } catch (error) {
    console.error("[agent/checkout] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
