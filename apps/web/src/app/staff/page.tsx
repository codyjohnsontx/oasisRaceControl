import { redirect } from "next/navigation";
import { serviceClient } from "@/lib/supabase";
import { getStaffUser } from "@/lib/staff";
import {
  StaffDashboard,
  type RigStatusRow,
  type StaffLapRow,
} from "@/components/staff-dashboard";

export default async function StaffPage() {
  const staff = await getStaffUser();
  if (!staff) redirect("/staff/login");

  const db = serviceClient();
  const [
    { data: rigs, error: rigsError },
    { data: laps, error: lapsError },
  ] = await Promise.all([
    db.from("v_rig_status").select("*"),
    db
      .from("laps")
      .select(
        "id, lap_time_ms, is_valid, invalid_reason, track_name, car_name, completed_at, drivers ( id, display_name ), rigs ( rig_number )",
      )
      .order("completed_at", { ascending: false })
      .limit(30),
  ]);

  // An empty dashboard that's actually a failed query would mislead staff into
  // thinking every rig is free — fail loudly via the Next error boundary.
  if (rigsError || lapsError) {
    throw new Error(
      `Staff dashboard query failed: ${rigsError?.message ?? lapsError?.message}`,
    );
  }

  const lapRows: StaffLapRow[] = (laps ?? []).map((lap) => {
    const driver = Array.isArray(lap.drivers) ? lap.drivers[0] : lap.drivers;
    const rig = Array.isArray(lap.rigs) ? lap.rigs[0] : lap.rigs;
    return {
      id: lap.id,
      lap_time_ms: lap.lap_time_ms,
      is_valid: lap.is_valid,
      invalid_reason: lap.invalid_reason,
      track_name: lap.track_name,
      car_name: lap.car_name,
      completed_at: lap.completed_at,
      driver_id: driver?.id ?? "",
      driver_name: driver?.display_name ?? "?",
      rig_number: rig?.rig_number ?? null,
    };
  });

  return (
    <StaffDashboard
      staffName={staff.displayName}
      rigs={(rigs ?? []) as RigStatusRow[]}
      laps={lapRows}
    />
  );
}
