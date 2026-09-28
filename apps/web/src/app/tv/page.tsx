import { listBoards } from "@/lib/leaderboards-queries";
import { tvMode } from "@/lib/tv-rotation";
import { TvScreen } from "@/components/tv/tv-screen";

/**
 * Front-of-store arcade high-score board. Point a kiosk browser at it and walk
 * away: it cycles every track with laps on it, refreshes itself, and recovers
 * from a dead feed without anyone touching the TV.
 *
 * `/tv?event=1` is the same screen in its event view: one board, every driver
 * with a lap today in the featured combo, scrolling on its own - for a laptop
 * at an off-site event, where the venue's rotation would show the same laps
 * under three headings (`buildRotation` in `components/tv/board-types.tsx`).
 *
 * The rotation list is seeded here so the first paint already has a board; the
 * client re-reads it periodically as new tracks get driven.
 */
export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function TvPage({ searchParams }: Props) {
  const mode = tvMode((await searchParams).event);

  // A database hiccup at render time must not blank the wall - the client
  // fetches its own rotation list anyway, so an empty seed self-corrects. The
  // event view's list does not depend on which boards exist, so it skips the
  // query rather than making one it will not read.
  let boards: Awaited<ReturnType<typeof listBoards>> = [];
  if (mode === "rotation") {
    try {
      boards = await listBoards();
    } catch (error) {
      console.error("[tv] initial board list failed", (error as Error).message);
    }
  }

  return <TvScreen initialBoards={boards} mode={mode} />;
}
