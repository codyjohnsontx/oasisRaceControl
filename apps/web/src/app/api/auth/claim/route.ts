import { z } from "zod";
import { queryOne } from "@/lib/db";
import { getDriverSession, setDriverSession } from "@/lib/driver-session";
import { parseJsonBody } from "@/lib/http";
import { pinSchema, hashPin } from "@/lib/driver-auth";

const body = z.object({ pin: pinSchema });

/** Upgrades a guest into a full profile on the SAME driver row — the night's
 * laps and results are preserved because nothing about lap ownership changes. */
export async function POST(request: Request) {
  const session = await getDriverSession();
  if (!session) return Response.json({ error: "not_signed_in" }, { status: 401 });
  if (!session.isGuest) {
    return Response.json({ error: "not_a_guest" }, { status: 400 });
  }

  const input = await parseJsonBody(request, body);
  if (input instanceof Response) return input;

  try {
    const driver = await queryOne<{ id: string; display_name: string }>(
      `update drivers
       set pin_hash = $2, is_guest = false, updated_at = now()
       where id = $1 and is_guest = true
       returning id, display_name`,
      [session.driverId, await hashPin(input.pin)],
    );

    // Zero rows: the row was already claimed (double-tap or a second device
    // racing this one) — the profile exists, so tell the client it's done.
    if (!driver) {
      return Response.json({ error: "already_claimed" }, { status: 409 });
    }

    await setDriverSession({
      driverId: driver.id,
      displayName: driver.display_name,
      isGuest: false,
    });
    return Response.json({ driverId: driver.id, displayName: driver.display_name });
  } catch (error) {
    console.error("[auth/claim] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
