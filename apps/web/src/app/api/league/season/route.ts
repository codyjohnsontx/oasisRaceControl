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
 * Standings are computed from round results by the swappable rule in
 * league-scoring.ts - the wall board never does arithmetic of its own.
 */
export async function GET(request: Request) {
  const seasonParam = new URL(request.url).searchParams.get("season");
  const seasonId = seasonParam && z.uuid().safeParse(seasonParam).success ? seasonParam : null;

  try {
    const season = seasonId ? await getSeason(seasonId) : await getActiveSeason();
    if (!season) return Response.json({ season: null, rounds: [], standings: [] });

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
