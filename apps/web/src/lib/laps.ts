import { query } from "./db";

export type PortalLap = {
  id: string;
  track_name: string;
  track_config: string | null;
  car_name: string;
  lap_number: number | null;
  lap_time_ms: number;
  is_valid: boolean;
  invalid_reason: string | null;
  completed_at: string;
};

/** A driver's laps, newest first. Shared by the /me page (initial render) and
 * the /api/me/laps polling endpoint so the shape stays in one place. */
export function getDriverLaps(driverId: string): Promise<PortalLap[]> {
  return query<PortalLap>(
    `select id, track_name, track_config, car_name, lap_number, lap_time_ms,
            is_valid, invalid_reason, completed_at
     from laps
     where driver_id = $1
     order by completed_at desc
     limit 200`,
    [driverId],
  );
}
