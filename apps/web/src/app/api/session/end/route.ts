import { queryOne } from "@/lib/db";
import { getDriverSession } from "@/lib/driver-session";

export async function POST() {
  const session = await getDriverSession();
  if (!session) return Response.json({ error: "not_signed_in" }, { status: 401 });

  try {
    const ended = await queryOne<{ id: string }>(
      `update rig_assignments
       set ended_at = now(), end_reason = 'driver_ended'
       where driver_id = $1 and ended_at is null
       returning id`,
      [session.driverId],
    );
    // ended: false = the update succeeded but there was no open assignment.
    return Response.json({ ended: Boolean(ended) });
  } catch (error) {
    console.error("[session/end] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
