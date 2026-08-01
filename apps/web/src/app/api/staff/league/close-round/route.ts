import { z } from "zod";
import { queryOne } from "@/lib/db";
import { getStaffUser, writeAudit } from "@/lib/staff";
import { parseJsonBody } from "@/lib/http";

const body = z.object({ roundId: z.uuid() });

/**
 * Close tonight's round. Closing freezes the round's lap window, so its result
 * stops changing when the next round starts - but staff can still invalidate a
 * lap afterwards and the standings follow, which is what a protest needs.
 */
export async function POST(request: Request) {
  const staff = await getStaffUser();
  if (!staff) return Response.json({ error: "forbidden" }, { status: 403 });

  const input = await parseJsonBody(request, body);
  if (input instanceof Response) return input;

  try {
    const round = await queryOne<{ id: string; round_number: number }>(
      `update league_rounds set closed_at = now()
       where id = $1 and closed_at is null
       returning id, round_number`,
      [input.roundId],
    );
    if (!round) {
      return Response.json({ error: "not_open" }, { status: 404 });
    }

    await writeAudit({
      staffUserId: staff.userId,
      action: "close_league_round",
      targetType: "league_round",
      targetId: round.id,
      detail: { roundNumber: round.round_number },
    });

    return Response.json({ roundId: round.id });
  } catch (error) {
    console.error("[staff/league/close-round] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
