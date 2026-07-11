import { clearDriverSession } from "@/lib/driver-session";

export async function POST() {
  await clearDriverSession();
  return Response.json({ ok: true });
}
