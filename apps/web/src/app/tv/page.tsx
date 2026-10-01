import { STAFF_BOARD_LINK_PARAM, pageBoardTicket } from "@/lib/board-ticket";
import { listBoards } from "@/lib/leaderboards-queries";
import { tvMode } from "@/lib/tv-rotation";
import { tvHostLogo } from "@/lib/tv-host-logo";
import { BoardHeartbeat } from "@/components/tv/board-heartbeat";
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
 * `&host=cadillac` puts the event host's logo in the footer
 * (`lib/tv-host-logo.ts`); the list can also be scrolled by hand there.
 *
 * The rotation list is seeded here so the first paint already has a board; the
 * client re-reads it periodically as new tracks get driven.
 *
 * Every page load opened from a staff link on /staff is also a board the rig
 * monitor watches: it gets its own id and a signed ticket here, and
 * heartbeats with them (`board-heartbeat.tsx`). An open event board is what
 * turns the monitor's event mode on. The public /tv and /tv?event=1 report
 * nothing (`lib/board-ticket.ts`).
 */
export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function TvPage({ searchParams }: Props) {
  const params = await searchParams;
  const mode = tvMode(params.event);
  const hostLogo = mode === "event" ? tvHostLogo(params.host) : null;

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

  // Without a ticket the wall still works; the monitor just cannot see it.
  let ticket: string | null = null;
  try {
    ticket = await pageBoardTicket({
      mode,
      host: hostLogo ? (params.host as string) : null,
      link: params[STAFF_BOARD_LINK_PARAM],
    });
  } catch (error) {
    console.error("[tv] cannot mint a board ticket", (error as Error).message);
  }

  return (
    <>
      <TvScreen initialBoards={boards} mode={mode} hostLogo={hostLogo} />
      {ticket && <BoardHeartbeat ticket={ticket} />}
    </>
  );
}
