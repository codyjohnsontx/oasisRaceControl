import { unstable_cache } from "next/cache";
import { redirect } from "next/navigation";
import { query, queryOne } from "@/lib/db";
import { getStaffUser } from "@/lib/staff";
import { VENUE_TIMEZONE, venueMonthName, venueToday } from "@/lib/venue";
import type { FeaturedCombo } from "@/lib/validity";
import {
  countRoundDrivers,
  getActiveSeason,
  getOpenRound,
  listSeasonRounds,
} from "@/lib/league-queries";
import { describeComboMismatch, type TonightCombo } from "@/lib/combo-mismatch";
import type { ComboOption } from "@/components/staff-league-panel";
import {
  StaffDashboard,
  type RigStatusRow,
  type StaffLapRow,
} from "@/components/staff-dashboard";

/**
 * Combos the venue has actually run, so opening a round is picking from a list
 * rather than retyping "Spa-Francorchamps" on a busy Wednesday. Most recently
 * run first and bounded to a season of history: staff want the combos currently
 * in rotation, not the alphabetically-first sixty ever.
 *
 * Cached rather than recomputed per render. This aggregates a quarter of the
 * `laps` table to fill a datalist whose contents change a few times a week,
 * while every open staff tablet re-runs this page four times a minute
 * (`StaffDashboard` refreshes on a 15s timer) - so the cadence that matters is
 * how often the answer changes, not how often the dashboard repaints.
 */
const listRecentCombos = unstable_cache(
  () =>
    query<ComboOption>(
      `select track_name, track_config, car_name
       from laps
       where completed_at > now() - interval '90 days'
       group by track_name, track_config, car_name
       order by max(completed_at) desc
       limit 60`,
    ),
  ["staff-league-combo-options"],
  { revalidate: 600 },
);

export default async function StaffPage() {
  const staff = await getStaffUser();
  if (!staff) redirect("/staff/login");

  // Failures throw to the error boundary — an empty dashboard that's actually
  // a failed query would mislead staff into thinking every rig is free.
  const [rigs, laps, openRound, season, todaysCombo, tonightCombos] = await Promise.all([
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
    queryOne<FeaturedCombo>(
      `select track_name, track_config, car_name, incident_limit
       from featured_combos where combo_date = $1`,
      [venueToday()],
    ),
    // What the room is actually driving tonight, by rig rather than by lap: a
    // mistyped combo is several rigs agreeing with each other and disagreeing
    // with the round, and one busy machine must not outweigh them
    // (describeComboMismatch owns that rule).
    query<TonightCombo>(
      `select track_name, track_config, car_name,
              count(*)::int as lap_count,
              count(distinct rig_id)::int as rig_count
       from laps
       where (completed_at at time zone $1)::date = venue_today()
       group by track_name, track_config, car_name`,
      [VENUE_TIMEZONE],
    ),
  ]);

  const [recentRounds, openRoundDrivers, comboOptions] = await Promise.all([
    season ? listSeasonRounds(season.id) : Promise.resolve([]),
    openRound ? countRoundDrivers(openRound.id) : Promise.resolve(0),
    listRecentCombos(),
  ]);

  return (
    <StaffDashboard
      staffName={staff.displayName}
      rigs={rigs}
      laps={laps}
      league={{
        seasonName: season?.name ?? null,
        nextSeasonName: venueMonthName(),
        openRound,
        openRoundDrivers,
        recentRounds: recentRounds.slice(0, 6),
        comboOptions,
        todaysCombo,
        comboMismatch: describeComboMismatch(tonightCombos, todaysCombo),
      }}
    />
  );
}
