import { z } from "zod";
import {
  getActiveSeason,
  getSeason,
  getSeasonRoundResults,
  listSeasonRounds,
} from "@/lib/league-queries";
import { computeSeasonStandings } from "@/lib/league-scoring";

/**
 * Season standings plus its rounds. Defaults to the season currently running;
 * `?season=<uuid>` reads a finished one.
 *
 * A `?season=` that is malformed or names no season is a 404, never a quiet
 * fallback to whatever is running now: standings get screenshotted and argued
 * over, and this month's numbers under last month's name is worse than an
 * error. A valid season that has simply ended still reads normally.
 *
 * Standings are computed from round results by the swappable rule in
 * league-scoring.ts - the wall board never does arithmetic of its own.
 */
export async function GET(request: Request) {
  const seasonParam = new URL(request.url).searchParams.get("season");
  if (seasonParam !== null && !z.uuid().safeParse(seasonParam).success) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const season = seasonParam ? await getSeason(seasonParam) : await getActiveSeason();
    if (!season) {
      // No season at all is the venue's normal state before the first round;
      // an identifier that resolves to nothing is a bad link.
      return seasonParam
        ? Response.json({ error: "not_found" }, { status: 404 })
        : Response.json({ season: null, rounds: [], standings: [] });
    }

    const [rounds, results] = await Promise.all([
      listSeasonRounds(season.id),
      getSeasonRoundResults(season.id),
    ]);

    return Response.json({
      season,
      rounds,
      standings: computeSeasonStandings(results),
    });
  } catch (error) {
    console.error("[league/season] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
