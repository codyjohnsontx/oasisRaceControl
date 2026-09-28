import { z } from "zod";
import { query, queryOne } from "@/lib/db";
import { TONIGHT_FEED_DEFAULT_ROWS, TONIGHT_FEED_MAX_ROWS } from "@/lib/leaderboards";
import { venueToday } from "@/lib/venue";

/**
 * `limit` is optional and bounded: unset means the cap the feed has always had,
 * and anything past `TONIGHT_FEED_MAX_ROWS` (or not a whole positive number) is
 * refused rather than clamped, so a caller asking for more than the feed gives
 * finds out instead of silently getting fewer rows than it asked for.
 */
const querySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(TONIGHT_FEED_MAX_ROWS)
    .default(TONIGHT_FEED_DEFAULT_ROWS),
});

/** Public leaderboard feed, polled by the TV (and anyone else). */
export async function GET(request: Request) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  try {
    const [rows, combo] = await Promise.all([
      // car_name comes along so the TV can show what each lap was set in. With
      // a featured combo it's the same car on every row; without one, tonight's
      // board spans combos and the car is the only thing telling them apart.
      //
      // incident_delta is the shown lap's own incident count, so the wall can
      // mark a time whose lap had an incident. The view does not carry it, and the
      // view is not redefined for a display detail (the hosted database is
      // migrated by hand), so it is read back off `laps` here by the columns
      // that identify the exact lap the view picked: the driver, the time, the
      // moment and the combo. Two valid laps by one driver identical in all of
      // those is a duplicate event, and the one with more incidents wins so the
      // mark is never lost to the tie.
      query<{
        driver_id: string;
        display_name: string;
        lap_time_ms: number;
        car_name: string;
        incident_delta: number | null;
      }>(
        `select v.driver_id, v.display_name, v.lap_time_ms, v.car_name, shown.incident_delta
         from v_fastest_tonight v
         left join lateral (
           select l.incident_delta
           from laps l
           where l.driver_id = v.driver_id
             and l.lap_time_ms = v.lap_time_ms
             and l.completed_at = v.completed_at
             and l.track_name = v.track_name
             and coalesce(l.track_config, '') = coalesce(v.track_config, '')
             and l.car_name = v.car_name
             and l.is_valid
           order by l.incident_delta desc nulls last
           limit 1
         ) shown on true
         order by v.lap_time_ms asc
         limit $1`,
        [parsed.data.limit],
      ),
      queryOne<{ track_name: string; track_config: string | null; car_name: string }>(
        `select track_name, track_config, car_name
         from featured_combos where combo_date = $1`,
        [venueToday()],
      ),
    ]);

    return Response.json({ rows, combo });
  } catch (error) {
    console.error("[leaderboard/tonight] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
