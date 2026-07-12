import { getDriverLaps } from "@/lib/laps";
import { getDriverSession } from "@/lib/driver-session";

/** The signed-in driver's laps, polled by the portal for live updates. */
export async function GET() {
  const session = await getDriverSession();
  if (!session) return Response.json({ error: "not_signed_in" }, { status: 401 });

  try {
    const laps = await getDriverLaps(session.driverId);
    return Response.json({ laps });
  } catch (error) {
    console.error("[me/laps] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
