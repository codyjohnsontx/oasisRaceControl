import { listBoards } from "@/lib/leaderboards-queries";

/** Public list of available boards (track + car combos with valid laps), for
 *  the leaderboards picker. No auth — anyone can browse, same as /tv. */
export async function GET() {
  try {
    return Response.json({ boards: await listBoards() });
  } catch (error) {
    console.error("[leaderboards/boards] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
