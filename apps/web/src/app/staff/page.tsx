import { redirect } from "next/navigation";
import { query, queryOne } from "@/lib/db";
import { getStaffUser } from "@/lib/staff";
import { venueToday } from "@/lib/venue";
import {
  getActiveSeason,
  getOpenRound,
  getRoundField,
  listSeasonRounds,
} from "@/lib/league-queries";
import type { ComboOption } from "@/components/staff-league-panel";
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
  const [rigs, laps, openRound, season, comboOptions, todaysCombo] = await Promise.all([
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
    getOpenRound(),
    getActiveSeason(),
    // Combos the venue has actually run, so opening a round is picking from a
    // list rather than retyping "Spa-Francorchamps" on a busy Wednesday.
    query<ComboOption>(
      `select distinct track_name, track_config, car_name
       from laps
       order by track_name, track_config nulls first, car_name
       limit 60`,
    ),
    queryOne<ComboOption>(
      `select track_name, track_config, car_name
       from featured_combos where combo_date = $1`,
      [venueToday()],
    ),
  ]);

  const [recentRounds, openField] = await Promise.all([
    season ? listSeasonRounds(season.id) : Promise.resolve([]),
    openRound ? getRoundField(openRound.id) : Promise.resolve([]),
  ]);

  return (
    <StaffDashboard
      staffName={staff.displayName}
      rigs={rigs}
      laps={laps}
      league={{
        seasonName: season?.name ?? null,
        openRound,
        openRoundDrivers: openField.length,
        recentRounds: recentRounds.slice(0, 6),
        comboOptions,
        todaysCombo,
      }}
    />
  );
}
