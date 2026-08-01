import { listBoards } from "@/lib/leaderboards-queries";
import { TvScreen } from "@/components/tv/tv-screen";

/**
 * Front-of-store arcade high-score board. Point a kiosk browser at it and walk
 * away: it cycles every track with laps on it, refreshes itself, and recovers
 * from a dead feed without anyone touching the TV.
 *
 * The rotation list is seeded here so the first paint already has a board; the
 * client re-reads it periodically as new tracks get driven.
 */
export const dynamic = "force-dynamic";

export default async function TvPage() {
  // A database hiccup at render time must not blank the wall - the client
  // fetches its own rotation list anyway, so an empty seed self-corrects.
  let boards: Awaited<ReturnType<typeof listBoards>> = [];
  try {
    boards = await listBoards();
  } catch (error) {
    console.error("[tv] initial board list failed", (error as Error).message);
  }

  return <TvScreen initialBoards={boards} />;
}
