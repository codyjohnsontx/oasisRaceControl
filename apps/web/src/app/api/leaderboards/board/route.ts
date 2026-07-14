import { z } from "zod";
import { getBoard } from "@/lib/leaderboards-queries";

// config is omitted (not empty) when the track's track_config is null.
const querySchema = z.object({
  track: z.string().min(1),
  config: z.string().optional(),
  window: z.enum(["alltime", "tonight"]).default("alltime"),
});

/** Public single-board ranking. Query params: track, optional config,
 *  window=alltime|tonight. One fastest lap per active driver (any car). */
export async function GET(request: Request) {
  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  const { track, config, window } = parsed.data;
  try {
    const rows = await getBoard(track, config?.length ? config : null, window);
    return Response.json({ rows });
  } catch (error) {
    console.error("[leaderboards/board] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
