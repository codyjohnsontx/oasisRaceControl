import { cache } from "react";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getDriverSession } from "@/lib/driver-session";
import { getRound, getRoundField, getRoundLaps } from "@/lib/league-queries";
import { lapsByDriver, roundLabel } from "@/lib/league";
import { LeagueRound } from "@/components/league-round";

/** Next runs generateMetadata and the page in the same request, and both need
 *  the round; cache() makes that one query instead of two. Returns null for a
 *  non-uuid id so neither caller hands a bad value to Postgres. */
const loadRound = cache(async (roundId: string) => {
  if (!z.uuid().safeParse(roundId).success) return null;
  return getRound(roundId);
});

/** One round's full field, expandable to every driver's laps. Phone-first;
 *  this is the comparison customers asked for after a league night. */
export default async function LeagueRoundPage({
  params,
}: {
  params: Promise<{ roundId: string }>;
}) {
  const { roundId } = await params;
  const round = await loadRound(roundId);
  if (!round) notFound();

  // The whole round's laps ship with the first render so the first tap expands
  // instantly; polling afterwards only refetches what is actually open.
  const [field, lapPage, viewer] = await Promise.all([
    getRoundField(roundId),
    getRoundLaps(roundId),
    getDriverSession(),
  ]);

  return (
    <LeagueRound
      round={round}
      initialField={field}
      initialLaps={lapsByDriver(lapPage.laps)}
      initialTruncated={lapPage.truncated}
      viewerDriverId={viewer?.driverId ?? null}
    />
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ roundId: string }>;
}) {
  const { roundId } = await params;
  const round = await loadRound(roundId);
  return {
    title: round
      ? `${roundLabel(round)} · League · Oasis Race Control`
      : "League · Oasis Race Control",
  };
}
