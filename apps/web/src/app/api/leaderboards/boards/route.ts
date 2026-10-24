import { listBoards, listLiveTracks } from "@/lib/leaderboards-queries";
import type { BoardsFeed } from "@/lib/leaderboards";

/**
 * Public list of the venue's tracks, for the `/tv` rotation to re-read: every
 * track with valid laps (`boards`) and every track a rig is on right now
 * (`live`, from the rigs' heartbeats - `lib/leaderboards.ts`). No auth -
 * anyone can browse, same as /tv. The phone's `/leaderboards` picker reads
 * `listBoards()` directly and never sees `live`, so a track nobody has lapped
 * yet is only ever a slide on the wall, not an empty board on a phone.
 */
export async function GET() {
  try {
    const [boards, live] = await Promise.all([listBoards(), listLiveTracks()]);
    return Response.json({ boards, live } satisfies BoardsFeed);
  } catch (error) {
    console.error("[leaderboards/boards] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
