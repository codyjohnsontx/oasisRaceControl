import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
import { setDriverSession } from "@/lib/driver-session";
import { parseJsonBody } from "@/lib/http";
import {
  displayNameSchema,
  pinSchema,
  hashPin,
  isUniqueViolation,
} from "@/lib/driver-auth";
import { rateLimit, clientIp } from "@/lib/rate-limit";

const body = z.object({ displayName: displayNameSchema, pin: pinSchema });

export async function POST(request: Request) {
  // Same unauthenticated row-creation exposure as the guest route.
  if (!rateLimit(`register:${clientIp(request)}`, 10, 60_000)) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const input = await parseJsonBody(request, body);
  if (input instanceof Response) return input;

  const db = serviceClient();
  const { data, error } = await db
    .from("drivers")
    .insert({
      display_name: input.displayName,
      pin_hash: await hashPin(input.pin),
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
