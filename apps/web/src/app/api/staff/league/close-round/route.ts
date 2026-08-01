import { z } from "zod";
import { closeLeagueRound } from "@/lib/league-queries";
import { getStaffUser, writeAudit } from "@/lib/staff";
import { parseJsonBody } from "@/lib/http";

const body = z.object({ roundId: z.uuid() });

/**
 * Close tonight's round. Closing freezes the round's lap window, so its result
 * stops changing when the next round starts - but staff can still invalidate a
 * lap afterwards and the standings follow, which is what a protest needs.
 *
 * It also undoes the featured-combo overwrite that opening the round did, so
 * the rest of the venue day goes back to whatever combo (or no combo) was set
 * before league night - see closeLeagueRound.
 */
export async function POST(request: Request) {
  const staff = await getStaffUser();
  if (!staff) return Response.json({ error: "forbidden" }, { status: 403 });

  const input = await parseJsonBody(request, body);
  if (input instanceof Response) return input;

  try {
    const round = await closeLeagueRound(input.roundId);
    if (!round) {
      return Response.json({ error: "not_open" }, { status: 404 });
    }

    await writeAudit({
      staffUserId: staff.userId,
      action: "close_league_round",
      targetType: "league_round",
      targetId: round.id,
      detail: {
        roundNumber: round.roundNumber,
        restoredFeaturedCombo: round.restoredCombo,
      },
    });

    return Response.json({ roundId: round.id });
  } catch (error) {
    console.error("[staff/league/close-round] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
