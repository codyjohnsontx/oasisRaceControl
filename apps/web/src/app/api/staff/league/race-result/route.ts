import { z } from "zod";
import { parseJsonBody, refuseCrossOriginRequest } from "@/lib/http";
import { saveRaceResult } from "@/lib/race-results";
import { getStaffUser, writeAudit } from "@/lib/staff";

/** More than a hosted iRacing session holds, so any real race fits. */
const MAX_ENTRANTS = 64;

const body = z
  .object({
    roundId: z.uuid(),
    /** Finishing order: the first driver is P1. */
    finishers: z.array(z.uuid()).max(MAX_ENTRANTS),
    /** In the race but not classified. */
    dnf: z.array(z.uuid()).max(MAX_ENTRANTS),
    /** Taken out of the race: in the round, with no race finish. */
    out: z.array(z.uuid()).max(MAX_ENTRANTS),
  })
  .refine((input) => input.finishers.length + input.dnf.length > 0, "empty_result")
  .refine(
    (input) =>
      new Set([...input.finishers, ...input.dnf, ...input.out]).size ===
      input.finishers.length + input.dnf.length + input.out.length,
    "driver_named_twice",
  );

/**
 * Staff's reviewed race result for tonight's open round, as corrected on
 * /staff: replaces whatever the rigs captured and freezes the round against
 * further capture (lib/race-results.ts). The round is placed and scored by it
 * from the next read of any league surface.
 */
export async function POST(request: Request) {
  const refused = refuseCrossOriginRequest(request);
  if (refused) return refused;

  const staff = await getStaffUser();
  if (!staff) return Response.json({ error: "forbidden" }, { status: 403 });

  const input = await parseJsonBody(request, body);
  if (input instanceof Response) return input;

  try {
    const saved = await saveRaceResult(input.roundId, input.finishers, input.dnf, input.out);
    if (saved.status === "not_open") {
      return Response.json({ error: "not_open" }, { status: 404 });
    }
    if (saved.status === "unknown_driver" || saved.status === "race_changed") {
      return Response.json({ error: saved.status }, { status: 409 });
    }

    await writeAudit({
      staffUserId: staff.userId,
      action: "save_league_race_result",
      targetType: "league_round",
      targetId: input.roundId,
      detail: { finishers: input.finishers, dnf: input.dnf },
    });

    return Response.json({ roundId: input.roundId });
  } catch (error) {
    console.error("[staff/league/race-result] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
