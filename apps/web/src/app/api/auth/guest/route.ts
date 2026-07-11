import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
import { setDriverSession } from "@/lib/driver-session";
import { displayNameSchema, isUniqueViolation } from "@/lib/driver-auth";

const body = z.object({ displayName: displayNameSchema });

/** Guest-first check-in: a display name is all it takes to start driving.
 * The row can be claimed into a full profile later — same driver id, so the
 * night's laps come along. */
export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  const db = serviceClient();
  const { data, error } = await db
    .from("drivers")
    .insert({ display_name: parsed.data.displayName, is_guest: true })
    .select("id, display_name")
    .single();

  if (error) {
    if (isUniqueViolation(error)) {
      const suggestion = `${parsed.data.displayName} ${Math.floor(10 + Math.random() * 90)}`;
      return Response.json({ error: "name_taken", suggestion }, { status: 409 });
    }
    return Response.json({ error: "server_error" }, { status: 500 });
  }

  await setDriverSession({
    driverId: data.id,
    displayName: data.display_name,
    isGuest: true,
  });
  return Response.json({ driverId: data.id, displayName: data.display_name });
}
