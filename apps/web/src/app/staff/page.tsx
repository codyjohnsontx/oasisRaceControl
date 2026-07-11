import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { getStaffUser } from "@/lib/staff";
import {
  StaffDashboard,
  type RigStatusRow,
  type StaffLapRow,
} from "@/components/staff-dashboard";

export default async function StaffPage() {
  const staff = await getStaffUser();
  if (!staff) redirect("/staff/login");

  // Failures throw to the error boundary — an empty dashboard that's actually
  // a failed query would mislead staff into thinking every rig is free.
  const [rigs, laps] = await Promise.all([
    query<RigStatusRow>("select * from v_rig_status"),
    query<StaffLapRow>(
      `select l.id, l.lap_time_ms, l.is_valid, l.invalid_reason, l.track_name,
              l.car_name, l.completed_at, d.id as driver_id,
              d.display_name as driver_name, r.rig_number
       from laps l
       join drivers d on d.id = l.driver_id
       join rigs r on r.id = l.rig_id
       order by l.completed_at desc
       limit 30`,
    ),
  ]);

  return <StaffDashboard staffName={staff.displayName} rigs={rigs} laps={laps} />;
}
