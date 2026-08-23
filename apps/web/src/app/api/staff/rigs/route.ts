import { z } from "zod";
import { getStaffUser, writeAudit } from "@/lib/staff";
import { parseJsonBody } from "@/lib/http";
import {
  RIG_NUMBER_TAKEN,
  createRig,
  defaultRigName,
} from "@/lib/rig-enrolment";

const body = z.object({
  // The number painted on the physical machine. Bounded rather than open so a
  // slipped keystroke on a busy evening cannot create "Rig 1200".
  rigNumber: z.number().int().min(1).max(999),
  displayName: z.string().trim().min(1).max(60).optional(),
});

/**
 * Adds a rig to the fleet and hands back its credentials once.
 *
 * The token is minted here and never accepted from the request: staff cannot
 * choose it, so no rig can be given a short one, a guessable one, or another
 * rig's.
 */
export async function POST(request: Request) {
  const staff = await getStaffUser();
  if (!staff) return Response.json({ error: "forbidden" }, { status: 403 });

  const input = await parseJsonBody(request, body);
  if (input instanceof Response) return input;

  try {
    const rig = await createRig({
      rigNumber: input.rigNumber,
      displayName: input.displayName || defaultRigName(input.rigNumber),
    });

    if (rig === RIG_NUMBER_TAKEN) {
      return Response.json(
        { error: RIG_NUMBER_TAKEN, rigNumber: input.rigNumber },
        { status: 409 },
      );
    }

    // The QR slug is on public display in the venue, so recording it is how a
    // reprint is possible later. The bearer token is not here and must never
    // be: an audit table staff can read would otherwise hold a live copy of
    // every rig's credentials.
    await writeAudit({
      staffUserId: staff.userId,
      action: "create_rig",
      targetType: "rig",
      targetId: rig.id,
      detail: {
        rigNumber: rig.rigNumber,
        displayName: rig.displayName,
        qrToken: rig.qrToken,
      },
    });

    return Response.json(
      {
        rig: { id: rig.id, rigNumber: rig.rigNumber, displayName: rig.displayName },
        agentToken: rig.agentToken,
        qrToken: rig.qrToken,
      },
      { status: 201 },
    );
  } catch (error) {
    // Never interpolate the request: a failed insert must not be the one place
    // a token reaches the logs.
    console.error("[staff/rigs] create failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
