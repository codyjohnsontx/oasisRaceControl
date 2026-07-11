import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
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

  const db = serviceClient();
  const { data, error } = await db
    .from("drivers")
    .update({
      pin_hash: await hashPin(input.pin),
      is_guest: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", session.driverId)
    .eq("is_guest", true)
    .select("id, display_name")
    .maybeSingle();

  if (error) {
    return Response.json({ error: "server_error" }, { status: 500 });
  }
  // Zero rows: the row was already claimed (double-tap or a second device
  // racing this one) — the profile exists, so tell the client it's done.
  if (!data) {
    return Response.json({ error: "already_claimed" }, { status: 409 });
  }

  await setDriverSession({
    driverId: data.id,
    displayName: data.display_name,
    isGuest: false,
  });
  return Response.json({ driverId: data.id, displayName: data.display_name });
}
