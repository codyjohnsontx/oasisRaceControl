import { SignJWT, jwtVerify } from "jose";
import type { BoardMode } from "@/lib/monitor/event-mode";
import { tvHostLogo } from "@/lib/tv-host-logo";

/**
 * The ticket a /tv page heartbeats with. The server mints it when it renders
 * the page - naming the board id it just made up, the mode and the host - and
 * signs it with SESSION_SECRET, so POST /api/tv/heartbeat, which is public,
 * only believes a board the server itself handed out. Without it anyone could
 * put the venue into event mode (and page the owner) with one curl.
 *
 * It lasts BOARD_TICKET_TTL_S and every accepted heartbeat renews it, so a
 * board left open for a whole event weekend keeps reporting; a page that has
 * not reached the site for that long has been dark for a day and a half, and
 * reloading it mints a new one.
 */

export const BOARD_TICKET_TTL_S = 36 * 60 * 60;
const AUDIENCE = "tv-board";

export type BoardTicket = { boardId: string; mode: BoardMode; host: string | null };

function secret(): Uint8Array {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("Missing environment variable SESSION_SECRET");
  return new TextEncoder().encode(value);
}

export async function mintBoardTicket(ticket: BoardTicket): Promise<string> {
  return new SignJWT({ mode: ticket.mode, host: ticket.host })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(ticket.boardId)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${BOARD_TICKET_TTL_S}s`)
    .sign(secret());
}

/**
 * The board the ticket names, or null for a forged, expired or foreign one.
 * Throws, rather than refusing the ticket, when SESSION_SECRET is missing:
 * that is the server's fault, not the board's.
 */
export async function verifyBoardTicket(token: string): Promise<BoardTicket | null> {
  const key = secret();
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      audience: AUDIENCE,
    });
    const { sub, mode, host } = payload;
    if (typeof sub !== "string" || (mode !== "rotation" && mode !== "event")) return null;
    if (host !== null && (typeof host !== "string" || !tvHostLogo(host))) return null;
    return { boardId: sub, mode, host };
  } catch {
    return null;
  }
}
