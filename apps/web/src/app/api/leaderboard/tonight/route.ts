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
      query<{
        driver_id: string;
        display_name: string;
        lap_time_ms: number;
        car_name: string;
      }>(
        `select driver_id, display_name, lap_time_ms, car_name
         from v_fastest_tonight
         order by lap_time_ms asc
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
