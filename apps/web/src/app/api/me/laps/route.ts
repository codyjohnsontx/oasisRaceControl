import { query } from "@/lib/db";
import { getDriverSession } from "@/lib/driver-session";

/** The signed-in driver's laps, polled by the portal for live updates. */
export async function GET() {
  const session = await getDriverSession();
  if (!session) return Response.json({ error: "not_signed_in" }, { status: 401 });

  try {
    const laps = await query(
      `select id, track_name, track_config, car_name, lap_number, lap_time_ms,
              is_valid, invalid_reason, completed_at
       from laps
       where driver_id = $1
       order by completed_at desc
       limit 200`,
      [session.driverId],
    );
    return Response.json({ laps });
  } catch (error) {
    console.error("[me/laps] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
