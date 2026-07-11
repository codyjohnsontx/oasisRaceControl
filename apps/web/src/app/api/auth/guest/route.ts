import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
import { setDriverSession } from "@/lib/driver-session";
import { parseJsonBody } from "@/lib/http";
import { displayNameSchema, isUniqueViolation } from "@/lib/driver-auth";

const body = z.object({ displayName: displayNameSchema });

/** Guest-first check-in: a display name is all it takes to start driving.
 * The row can be claimed into a full profile later — same driver id, so the
 * night's laps come along. */
export async function POST(request: Request) {
  const input = await parseJsonBody(request, body);
  if (input instanceof Response) return input;

  const db = serviceClient();
  const { data, error } = await db
    .from("drivers")
    .insert({ display_name: input.displayName, is_guest: true })
    .select("id, display_name")
    .single();

  if (error) {
    if (isUniqueViolation(error)) {
      const suggestion = `${input.displayName} ${Math.floor(10 + Math.random() * 90)}`;
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
