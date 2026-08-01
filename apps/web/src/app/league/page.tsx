import type { Metadata } from "next";
import { z } from "zod";
import { getDriverSession } from "@/lib/driver-session";
import {
  getActiveSeason,
  getSeason,
  getSeasonRoundResults,
  listSeasonRounds,
} from "@/lib/league-queries";
import { computeSeasonStandings } from "@/lib/league-scoring";
import { LeagueStandings } from "@/components/league-standings";

export const metadata: Metadata = { title: "League standings · Oasis Race Control" };

/**
 * The league board: season standings across every round, plus a strip of
 * rounds linking into the per-round comparison. Public, like /leaderboards -
 * it is what goes on the wall screen on league night, and the same URL is a
 * normal page on a phone.
 *
 * Deliberately its own route: /tv is a separate surface and is not touched.
 */
export default async function LeaguePage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string }>;
}) {
  const { season: seasonParam } = await searchParams;
  const seasonId =
    seasonParam && z.uuid().safeParse(seasonParam).success ? seasonParam : null;

  const [season, viewer] = await Promise.all([
    seasonId ? getSeason(seasonId) : getActiveSeason(),
    getDriverSession(),
  ]);

  if (!season) {
    return (
      <LeagueStandings
        season={null}
        initialStandings={[]}
        initialRounds={[]}
        viewerDriverId={viewer?.driverId ?? null}
      />
    );
  }

  const [rounds, results] = await Promise.all([
    listSeasonRounds(season.id),
    getSeasonRoundResults(season.id),
  ]);

  return (
    <LeagueStandings
      season={season}
      initialStandings={computeSeasonStandings(results)}
      initialRounds={rounds}
      viewerDriverId={viewer?.driverId ?? null}
    />
  );
}
