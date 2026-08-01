import { rollLeagueSeason } from "@/lib/league-queries";
import { getStaffUser, writeAudit } from "@/lib/staff";

/**
 * Close out the season that is running and start the next one.
 *
 * A season is a calendar month at this venue, so a shop employee does this
 * roughly twelve times a year: the new season is named for the current venue
 * month automatically. Ending and starting share one transaction, so there is
 * no moment where rounds have no season to land in.
 *
 * Refused with 409 `round_open` while tonight's round is still open - closing
 * the season around a live round would strand it out of the standings the
 * board shows.
 */
export async function POST() {
  const staff = await getStaffUser();
  if (!staff) return Response.json({ error: "forbidden" }, { status: 403 });

  try {
    const result = await rollLeagueSeason();

    if (result.status === "round_open") {
      return Response.json(
        { error: "round_open", roundId: result.roundId },
        { status: 409 },
      );
    }
    if (result.status === "no_season") {
      return Response.json({ error: "no_season" }, { status: 404 });
    }

    await writeAudit({
      staffUserId: staff.userId,
      action: "roll_league_season",
      targetType: "league_season",
      targetId: result.seasonId,
      detail: {
        endedSeasonId: result.endedSeasonId,
        endedSeasonName: result.endedSeasonName,
        seasonName: result.seasonName,
      },
    });

    return Response.json({ seasonId: result.seasonId, seasonName: result.seasonName });
  } catch (error) {
    console.error("[staff/league/roll-season] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
