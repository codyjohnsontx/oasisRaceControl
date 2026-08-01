import type { Metadata } from "next";
import { notFound } from "next/navigation";
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
 * The full league surface: season standings across every round, plus a strip of
 * rounds linking into the per-round comparison. Public, like /leaderboards.
 *
 * This is the page customers open on their phones and the one staff park a
 * browser on to read a season in detail. The unattended wall has its own,
 * simpler league board inside the /tv rotation (see
 * `components/tv/board-types.tsx`) - the two read the same API and neither
 * wraps the other.
 *
 * A `?season=` that is malformed or names no season is a 404 rather than a
 * quiet fallback to the season running now; a valid ended season still renders
 * its own historical standings.
 */
export default async function LeaguePage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string }>;
}) {
  const { season: seasonParam } = await searchParams;
  if (seasonParam !== undefined && !z.uuid().safeParse(seasonParam).success) notFound();

  const [season, viewer] = await Promise.all([
    seasonParam ? getSeason(seasonParam) : getActiveSeason(),
    getDriverSession(),
  ]);

  if (!season) {
    // No season at all is the venue's normal state before the first round; an
    // identifier that resolves to nothing is a bad link.
    if (seasonParam) notFound();
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
