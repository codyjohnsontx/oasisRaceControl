import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
import { setDriverSession } from "@/lib/driver-session";
import {
  displayNameSchema,
  pinSchema,
  hashPin,
  isUniqueViolation,
} from "@/lib/driver-auth";

const body = z.object({ displayName: displayNameSchema, pin: pinSchema });

export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  const db = serviceClient();
  const { data, error } = await db
    .from("drivers")
    .insert({
      display_name: parsed.data.displayName,
      pin_hash: await hashPin(parsed.data.pin),
      is_guest: false,
    })
    .select("id, display_name")
    .single();

  if (error) {
    if (isUniqueViolation(error)) {
      return Response.json({ error: "name_taken" }, { status: 409 });
    }
    return Response.json({ error: "server_error" }, { status: 500 });
  }

  await setDriverSession({
    driverId: data.id,
    displayName: data.display_name,
    isGuest: false,
  });
  return Response.json({ driverId: data.id, displayName: data.display_name });
}
