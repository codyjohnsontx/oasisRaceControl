import { serviceClient } from "@/lib/supabase";
import { getDriverSession } from "@/lib/driver-session";
import { Portal, type PortalLap } from "@/components/portal";
import { SignInGate } from "@/components/sign-in-gate";

export default async function MePage() {
  const session = await getDriverSession();
  if (!session) return <SignInGate />;

  const db = serviceClient();

  const [{ data: assignment }, { data: laps }] = await Promise.all([
    db
      .from("rig_assignments")
      .select("id, started_at, rigs ( rig_number )")
      .eq("driver_id", session.driverId)
      .is("ended_at", null)
      .maybeSingle(),
    db
      .from("laps")
      .select(
        "id, track_name, track_config, car_name, lap_number, lap_time_ms, is_valid, invalid_reason, completed_at",
      )
      .eq("driver_id", session.driverId)
      .order("completed_at", { ascending: false })
      .limit(200),
  ]);

  const rig = assignment
    ? (Array.isArray(assignment.rigs) ? assignment.rigs[0] : assignment.rigs)
    : null;

  return (
    <Portal
      driverId={session.driverId}
      displayName={session.displayName}
      isGuest={session.isGuest}
      activeRigNumber={rig?.rig_number ?? null}
      initialLaps={(laps ?? []) as PortalLap[]}
    />
  );
}
