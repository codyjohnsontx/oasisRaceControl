import { notFound } from "next/navigation";
import { z } from "zod";
import { getDriverSession } from "@/lib/driver-session";
import { getRound, getRoundField, getRoundLaps } from "@/lib/league-queries";
import { lapsByDriver, roundLabel } from "@/lib/league";
import { LeagueRound } from "@/components/league-round";

/** One round's full field, expandable to every driver's laps. Phone-first;
 *  this is the comparison customers asked for after a league night. */
export default async function LeagueRoundPage({
  params,
}: {
  params: Promise<{ roundId: string }>;
}) {
  const { roundId } = await params;
  if (!z.uuid().safeParse(roundId).success) notFound();

  const round = await getRound(roundId);
  if (!round) notFound();

  // The whole round's laps ship with the first render so the first tap expands
  // instantly; polling afterwards only refetches what is actually open.
  const [field, laps, viewer] = await Promise.all([
    getRoundField(roundId),
    getRoundLaps(roundId),
    getDriverSession(),
  ]);

  return (
    <LeagueRound
      round={round}
      initialField={field}
      initialLaps={lapsByDriver(laps)}
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
  if (!z.uuid().safeParse(roundId).success) return { title: "League · Oasis Race Control" };
  const round = await getRound(roundId);
  return {
    title: round
      ? `${roundLabel(round)} · League · Oasis Race Control`
      : "League · Oasis Race Control",
  };
}
