import { queryOne } from "@/lib/db";
import { getDriverLaps } from "@/lib/laps";
import { getDriverSession } from "@/lib/driver-session";
import { Portal } from "@/components/portal";
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
    getDriverLaps(session.driverId),
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
