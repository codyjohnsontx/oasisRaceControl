import { z } from "zod";
import { query } from "@/lib/db";
import { mintBoardTicket, verifyBoardTicket, type BoardTicket } from "@/lib/board-ticket";
import { parseJsonBody } from "@/lib/http";
import { scheduleMonitor } from "@/lib/monitor/run";
import { clientIp, rateLimit } from "@/lib/rate-limit";

/**
 * A /tv page's heartbeat (components/tv/board-heartbeat.tsx): every 30 s while
 * the page is open, and once more with `closing: true` as it closes, sent with
 * navigator.sendBeacon - which posts text/plain, so the body is parsed as JSON
 * whatever its content type says.
 *
 * Public, like the page, and trusted only as far as its ticket: the board id,
 * mode and host are the ones the server signed into it when it rendered the
 * page (lib/board-ticket.ts), never the body's, so a forged heartbeat cannot
 * put the venue into event mode. Each accepted heartbeat renews the ticket and,
 * like a rig's, runs a monitor evaluation after the response has gone - the
 * event board is what notices a silent rig during an event.
 */

const body = z.object({
  ticket: z.string().min(1).max(2000),
  visible: z.boolean().nullable().optional(),
  feedOk: z.boolean().nullable().optional(),
  feedFailures: z.number().int().min(0).max(1_000_000).optional(),
  closing: z.boolean().optional(),
});

/** Two a minute per open board; this leaves room for a dozen behind one address. */
const RATE_LIMIT = 30;

export async function POST(request: Request) {
  if (!rateLimit(`tv-heartbeat:${clientIp(request)}`, RATE_LIMIT, 60_000)) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const input = await parseJsonBody(request, body);
  if (input instanceof Response) return input;

  let board: BoardTicket | null;
  try {
    board = await verifyBoardTicket(input.ticket);
  } catch (error) {
    console.error("[tv/heartbeat] cannot check tickets", (error as Error).message);
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
  if (!board) return Response.json({ error: "invalid_ticket" }, { status: 401 });

  try {
    // A goodbye is final for its board. A heartbeat that was in flight as the
    // tab closed can land after the beacon and must not undo it, and a page
    // restored from the back-forward cache reloads as a new board rather than
    // reopening this one (board-heartbeat.tsx).
    await query(
      `insert into board_heartbeats (board_id, mode, host, visible, feed_ok, feed_failures, closed_at)
       values ($1, $2, $3, $4, $5, $6, case when $7 then now() end)
       on conflict (board_id) do update set
         last_seen_at = now(),
         visible = excluded.visible,
         feed_ok = excluded.feed_ok,
         feed_failures = excluded.feed_failures,
         closed_at = coalesce(board_heartbeats.closed_at, excluded.closed_at)`,
      [
        board.boardId,
        board.mode,
        board.host,
        input.visible ?? null,
        input.feedOk ?? null,
        input.feedFailures ?? 0,
        input.closing === true,
      ],
    );
    if (input.closing) return Response.json({ ok: true });

    const ticket = await mintBoardTicket(board);
    scheduleMonitor();
    return Response.json({ ticket });
  } catch (error) {
    console.error("[tv/heartbeat] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
