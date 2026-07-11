import { query, queryOne } from "@/lib/db";
import { venueToday } from "@/lib/venue";

/** Public leaderboard feed, polled by the TV (and anyone else). */
export async function GET() {
  try {
    const [rows, combo] = await Promise.all([
      query<{ driver_id: string; display_name: string; lap_time_ms: number }>(
        `select driver_id, display_name, lap_time_ms
         from v_fastest_tonight
         order by lap_time_ms asc
         limit 15`,
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
