import { z } from "zod";
import { getRound, getRoundField, getRoundLaps } from "@/lib/league-queries";

/**
 * One round: the ranked field, and optionally one driver's laps in that round
 * (`?driver=<uuid>`).
 *
 * The round page server-renders the whole field with every driver's laps, then
 * polls this while the round is open - the field for the ranking, and just the
 * expanded driver's laps. That keeps a phone in the paddock refreshing a few KB
 * every few seconds instead of the whole night's laps.
 *
 * Public like /leaderboards and /tv: the wall screen and customers' phones both
 * read it with no session.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ roundId: string }> },
) {
  const { roundId } = await params;
  if (!z.uuid().safeParse(roundId).success) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const driverParam = new URL(request.url).searchParams.get("driver");
  const driverId = driverParam && z.uuid().safeParse(driverParam).success ? driverParam : null;

  try {
    const round = await getRound(roundId);
    if (!round) return Response.json({ error: "not_found" }, { status: 404 });

    const [field, laps] = await Promise.all([
      getRoundField(roundId),
      driverId ? getRoundLaps(roundId, driverId) : Promise.resolve(null),
    ]);

    return Response.json({ round, field, laps });
  } catch (error) {
    console.error("[league/rounds] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
