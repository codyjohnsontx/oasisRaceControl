import { z } from "zod";
import { repointOpenRound } from "@/lib/league-queries";
import { getStaffUser, writeAudit } from "@/lib/staff";
import { parseJsonBody } from "@/lib/http";

const body = z.object({
  trackName: z.string().trim().min(1).max(120),
  trackConfig: z.string().trim().max(120).nullish(),
  carName: z.string().trim().min(1).max(120),
});

/**
 * Repoint tonight's open round at what the rigs are actually running.
 *
 * The recovery for a combo typed one character off the sim's own name, which
 * leaves the round with no field and the leaderboard empty while every rig is
 * green (`describeComboMismatch` is what notices). Staff answer it from the
 * dashboard in one tap, and the whole night's laps appear as it commits -
 * nothing here touches a lap, because which content counts is asked at read
 * time rather than frozen into the lap.
 *
 * Deliberately not close-and-reopen: that spends a round number and leaves an
 * empty round in the season standings. Deliberately not an edit of a closed
 * round either - a finished round's combo is a result, and the ranking of a
 * night already published must not move under it.
 */
export async function POST(request: Request) {
  const staff = await getStaffUser();
  if (!staff) return Response.json({ error: "forbidden" }, { status: 403 });

  const input = await parseJsonBody(request, body);
  if (input instanceof Response) return input;

  // Trimmed by the schema, so a layout that was tabbed through arrives as ""
  // and normalizes to null - the same value the agent sends for a track that
  // has no layouts.
  const trackConfig = input.trackConfig || null;

  try {
    const round = await repointOpenRound({
      trackName: input.trackName,
      trackConfig,
      carName: input.carName,
    });
    if (!round) {
      return Response.json({ error: "no_open_round" }, { status: 409 });
    }

    await writeAudit({
      staffUserId: staff.userId,
      action: "repoint_league_round",
      targetType: "league_round",
      targetId: round.id,
      detail: {
        roundNumber: round.roundNumber,
        trackName: round.trackName,
        trackConfig: round.trackConfig,
        carName: round.carName,
      },
    });

    return Response.json({ roundId: round.id, roundNumber: round.roundNumber });
  } catch (error) {
    console.error("[staff/league/fix-combo] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
