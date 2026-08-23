import { z } from "zod";
import { queryOne, isUniqueViolation } from "@/lib/db";
import { setDriverSession } from "@/lib/driver-session";
import { parseJsonBody } from "@/lib/http";
import { displayNameSchema } from "@/lib/driver-auth";
import { allowNewDriver } from "@/lib/rate-limit";

const body = z.object({
  displayName: displayNameSchema,
  /** The rig code the check-in page was opened with, so the throttle can key on
   * the seat rather than on the address the whole venue shares. */
  qrToken: z.string().min(1).max(120).optional(),
});

/** Guest-first check-in: a display name is all it takes to start driving.
 * The row can be claimed into a full profile later — same driver id, so the
 * night's laps come along. */
export async function POST(request: Request) {
  const input = await parseJsonBody(request, body);
  if (input instanceof Response) return input;

  // Unauthenticated row creation needs throttling, but the venue shares one
  // public address, so it is keyed on the rig the customer is standing at
  // whenever the check-in page supplied one - see allowNewDriver.
  if (!(await allowNewDriver(request, input.qrToken))) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  try {
    const driver = await queryOne<{ id: string; display_name: string }>(
      `insert into drivers (display_name, is_guest)
       values ($1, true)
       returning id, display_name`,
      [input.displayName],
    );
    if (!driver) return Response.json({ error: "server_error" }, { status: 500 });

    await setDriverSession({
      driverId: driver.id,
      displayName: driver.display_name,
      isGuest: true,
    });
    return Response.json({ driverId: driver.id, displayName: driver.display_name });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const suggestion = `${input.displayName} ${Math.floor(10 + Math.random() * 90)}`;
      return Response.json({ error: "name_taken", suggestion }, { status: 409 });
    }
    console.error("[auth/guest] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
