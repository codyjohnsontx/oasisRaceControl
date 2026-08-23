import { z } from "zod";
import { queryOne } from "@/lib/db";
import { rigFromBearer } from "@/lib/agent-auth";

/**
 * Why an agent ended a check-in. Only the two reasons a rig can legitimately
 * claim: the person standing at the machine pressed sign out, or the rig signed
 * out a customer who left with iRacing closed behind them. The other values of
 * `assignment_end_reason` belong to staff and to check-in itself, and an agent
 * must not be able to write them.
 */
const agentEndReason = z.enum(["switched", "idle_timeout"]);

const body = z.object({
  /**
   * The check-in to end. Absent means "whoever is checked in", which is what the
   * rig's own sign-out button means - the person pressing it is standing there.
   *
   * An automatic sign-out names the check-in it judged instead. It decides after
   * watching a closed simulator for several minutes, and a walk-in can scan the
   * QR code in the moment between that decision and this request; ending
   * "whatever is open" would sign out the customer who just sat down.
   */
  assignmentId: z.uuid().optional(),
  reason: agentEndReason.optional(),
});

/**
 * Ends the rig's open assignment — the agent's "switch driver / sign out"
 * action, and the automatic sign-out of a customer who has gone home
 * (`IdleWatch` in apps/rig-agent). Agent-authed and scoped to the caller's own
 * rig; laps on the closed assignment are never touched.
 *
 * The body is optional: an older agent posts nothing at all, which still means
 * "end whoever is checked in, they switched".
 */
export async function POST(request: Request) {
  const rig = await rigFromBearer(request.headers.get("authorization"));
  if (!rig) return Response.json({ error: "unauthorized" }, { status: 401 });

  const raw = await request.json().catch(() => null);
  const parsed = body.safeParse(raw ?? {});
  if (!parsed.success) {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }
  const { assignmentId, reason = "switched" } = parsed.data;

  try {
    const ended = await queryOne<{ id: string }>(
      `update rig_assignments
       set ended_at = now(), end_reason = $2
       where rig_id = $1 and ended_at is null
         and ($3::uuid is null or id = $3::uuid)
       returning id`,
      [rig.id, reason, assignmentId ?? null],
    );
    // ended: false = no one was checked in, or the named check-in had already
    // been closed or replaced. Both mean this request must change nothing.
    return Response.json({ ended: Boolean(ended) });
  } catch (error) {
    console.error("[agent/checkout] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
