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
 * the /api/me/laps polling endpoint so the shape stays in one place.
 *
 * `id desc` is a deterministic tiebreak so laps sharing a completed_at don't
 * reorder between the two consumers. completed_at is normalized to an ISO
 * string here so both the server-rendered page and the JSON API hand the
 * component the same shape (pg returns a Date; the API would stringify it). */
export async function getDriverLaps(driverId: string): Promise<PortalLap[]> {
  const rows = await query<Omit<PortalLap, "completed_at"> & { completed_at: Date | string }>(
    `select id, track_name, track_config, car_name, lap_number, lap_time_ms,
            is_valid, invalid_reason, completed_at
     from laps
     where driver_id = $1
     order by completed_at desc, id desc
     limit 200`,
    [driverId],
  );
  return rows.map((row) => ({
    ...row,
    completed_at: new Date(row.completed_at).toISOString(),
  }));
}
