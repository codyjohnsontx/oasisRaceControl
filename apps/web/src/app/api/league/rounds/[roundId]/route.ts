import { z } from "zod";
import { lapsByDriver, MAX_ROUND_DRIVERS, roundLapsTruncated } from "@/lib/league";
import { getRound, getRoundField, getRoundLaps } from "@/lib/league-queries";

/**
 * One round: the ranked field, plus the laps of the drivers asked for in
 * `?drivers=<uuid>,<uuid>` keyed by driver id.
 *
 * The round page server-renders the whole field with every driver's laps, then
 * polls this while the round is open - one request per tick carrying the
 * ranking and every expanded row, so twenty open rows cost one field
 * aggregation rather than twenty-one.
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

  const driversParam = new URL(request.url).searchParams.get("drivers");
  let driverIds: string[] | null = null;
  if (driversParam !== null) {
    driverIds = [...new Set(driversParam.split(",").filter(Boolean))];
    if (
      driverIds.length === 0 ||
      driverIds.length > MAX_ROUND_DRIVERS ||
      driverIds.some((id) => !z.uuid().safeParse(id).success)
    ) {
      return Response.json({ error: "invalid_input" }, { status: 400 });
    }
  }

  try {
    const round = await getRound(roundId);
    if (!round) return Response.json({ error: "not_found" }, { status: 404 });

    const [field, lapPage] = await Promise.all([
      getRoundField(roundId),
      driverIds ? getRoundLaps(roundId, driverIds) : Promise.resolve(null),
    ]);

    // Every requested driver gets a key, so a driver whose laps all went away
    // reads as empty rather than leaving the client's last copy on screen.
    const laps = driverIds
      ? {
          ...Object.fromEntries(driverIds.map((id) => [id, []])),
          ...lapsByDriver(lapPage?.laps ?? []),
        }
      : null;

    // Two separate facts, deliberately not one flag: `truncated` is about this
    // request's driver filter, `roundTruncated` is about the whole round. A
    // poll asking for one expanded row must never clear the round-level notice.
    return Response.json({
      round,
      field,
      laps,
      truncated: lapPage?.truncated ?? false,
      roundTruncated: roundLapsTruncated(field),
    });
  } catch (error) {
    console.error("[league/rounds] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
