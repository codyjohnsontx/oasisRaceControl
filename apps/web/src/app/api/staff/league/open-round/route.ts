import { z } from "zod";
import { isUniqueViolation } from "@/lib/db";
import { getOpenRound, openLeagueRound } from "@/lib/league-queries";
import { getStaffUser, writeAudit } from "@/lib/staff";
import { parseJsonBody } from "@/lib/http";

const body = z.object({
  trackName: z.string().trim().min(1).max(120),
  trackConfig: z.string().trim().max(120).nullish(),
  carName: z.string().trim().min(1).max(120),
  name: z.string().trim().max(80).nullish(),
  incidentLimit: z.number().int().min(0).max(99).default(0),
});

/**
 * Open tonight's league round against a chosen combo.
 *
 * Side effect worth knowing about: this also sets today's featured combo to
 * the round's combo. Lap validity (src/lib/validity.ts) is judged against the
 * featured combo at ingestion time, so without this a league round on a
 * different combo than the day's featured one would mark every league lap
 * invalid. Laps already logged today keep the validity they were given, and
 * closing the round puts whatever the combo was back (see closeLeagueRound).
 */
export async function POST(request: Request) {
  const staff = await getStaffUser();
  if (!staff) return Response.json({ error: "forbidden" }, { status: 403 });

  const input = await parseJsonBody(request, body);
  if (input instanceof Response) return input;

  const alreadyOpen = await getOpenRound();
  if (alreadyOpen) {
    return Response.json(
      { error: "round_already_open", roundId: alreadyOpen.id },
      { status: 409 },
    );
  }

  // The schema already trimmed these, so an all-whitespace layout arrives as ""
  // and normalizes to null here.
  const trackConfig = input.trackConfig || null;

  try {
    const round = await openLeagueRound({
      name: input.name || null,
      trackName: input.trackName,
      trackConfig,
      carName: input.carName,
      incidentLimit: input.incidentLimit,
    });

    await writeAudit({
      staffUserId: staff.userId,
      action: "open_league_round",
      targetType: "league_round",
      targetId: round.id,
      detail: {
        seasonId: round.seasonId,
        roundNumber: round.roundNumber,
        trackName: input.trackName,
        trackConfig,
        carName: input.carName,
        incidentLimit: input.incidentLimit,
      },
    });

    return Response.json({ roundId: round.id, roundNumber: round.roundNumber });
  } catch (error) {
    // Two staff opening a round at the same moment: one_open_round_venue_wide
    // rejects the loser rather than leaving laps ambiguous.
    if (isUniqueViolation(error)) {
      return Response.json({ error: "round_already_open" }, { status: 409 });
    }
    console.error("[staff/league/open-round] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
