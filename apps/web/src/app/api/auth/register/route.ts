import { z } from "zod";
import { queryOne, isUniqueViolation } from "@/lib/db";
import { setDriverSession } from "@/lib/driver-session";
import { parseJsonBody } from "@/lib/http";
import { displayNameSchema, pinSchema, hashPin } from "@/lib/driver-auth";
import { allowNewDriver } from "@/lib/rate-limit";

const body = z.object({
  displayName: displayNameSchema,
  pin: pinSchema,
  /** See the guest route: the seat, not the address the venue shares. */
  qrToken: z.string().min(1).max(120).optional(),
});

export async function POST(request: Request) {
  const input = await parseJsonBody(request, body);
  if (input instanceof Response) return input;

  // Same unauthenticated row-creation exposure as the guest route, and the same
  // reason it is not keyed on the address.
  if (!(await allowNewDriver(request, input.qrToken))) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  try {
    const driver = await queryOne<{ id: string; display_name: string }>(
      `insert into drivers (display_name, pin_hash, is_guest)
       values ($1, $2, false)
       returning id, display_name`,
      [input.displayName, await hashPin(input.pin)],
    );
    if (!driver) return Response.json({ error: "server_error" }, { status: 500 });

    await setDriverSession({
      driverId: driver.id,
      displayName: driver.display_name,
      isGuest: false,
    });
    return Response.json({ driverId: driver.id, displayName: driver.display_name });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return Response.json({ error: "name_taken" }, { status: 409 });
    }
    console.error("[auth/register] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
