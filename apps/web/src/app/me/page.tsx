import { query, queryOne } from "@/lib/db";
import { getDriverSession } from "@/lib/driver-session";
import { Portal, type PortalLap } from "@/components/portal";
import { SignInGate } from "@/components/sign-in-gate";

export default async function MePage() {
  const session = await getDriverSession();
  if (!session) return <SignInGate />;

  const [assignment, laps] = await Promise.all([
    queryOne<{ rig_number: number }>(
      `select r.rig_number
       from rig_assignments ra
       join rigs r on r.id = ra.rig_id
       where ra.driver_id = $1 and ra.ended_at is null`,
      [session.driverId],
    ),
    query<PortalLap>(
      `select id, track_name, track_config, car_name, lap_number, lap_time_ms,
              is_valid, invalid_reason, completed_at
       from laps
       where driver_id = $1
       order by completed_at desc
       limit 200`,
      [session.driverId],
    ),
  ]);

  return (
    <Portal
      displayName={session.displayName}
      isGuest={session.isGuest}
      activeRigNumber={assignment?.rig_number ?? null}
      initialLaps={laps}
    />
  );
}
