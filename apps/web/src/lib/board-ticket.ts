import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { BoardMode } from "@/lib/monitor/event-mode";
import { tvHostLogo } from "@/lib/tv-host-logo";

/**
 * The ticket a /tv page heartbeats with. The server mints it when it renders
 * the page - naming the board id it just made up, the mode and the host - and
 * signs it with SESSION_SECRET, so POST /api/tv/heartbeat, which is public,
 * only believes a board the server itself handed out.
 *
 * Rendering the page is not proof enough, because anyone can load /tv and
 * /tv?event=1. A board - the shop wall or the event board, whose heartbeats
 * turn event mode on and raise rules 8a and 8b - gets a ticket only when the
 * page was opened from a staff link (`staffBoardLink`, on /staff), which
 * carries a signature of its own. The public pages still show the board to
 * anyone; they just report nothing, so no stranger, curl or stray phone can
 * switch the venue's channel into event mode or page the owner.
 *
 * It lasts BOARD_TICKET_TTL_S and every accepted heartbeat renews it, so a
 * board left open for a whole event weekend keeps reporting; a page that has
 * not reached the site for that long has been dark for a day and a half, and
 * reloading it mints a new one.
 */

export const BOARD_TICKET_TTL_S = 36 * 60 * 60;
const AUDIENCE = "tv-board";

/**
 * How long a staff link opens a board. The event board's lasts a two-day event
 * from its first morning, so the laptop's board can be reloaded on day two.
 * The shop wall's lasts a year, because the wall's kiosk reopens its bookmark
 * after every restart, and a wall that stopped reporting would say nothing.
 * A board already open keeps reporting past either, on its renewed ticket.
 */
export const STAFF_BOARD_LINK_TTL_S: Record<BoardMode, number> = {
  event: 48 * 60 * 60,
  rotation: 365 * 24 * 60 * 60,
};
const LINK_AUDIENCE = "tv-board-link";
/** The /tv search parameter the staff link's signature rides in. */
export const STAFF_BOARD_LINK_PARAM = "staff";

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

/**
 * The /tv link staff open a board from: the shop wall, or the event board for
 * a host or none. It is signed for its mode, so a wall link cannot open an
 * event board.
 */
export async function staffBoardLink(mode: BoardMode, host: string | null): Promise<string> {
  const signature = await new SignJWT({ mode })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(LINK_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${STAFF_BOARD_LINK_TTL_S[mode]}s`)
    .sign(secret());
  const query = new URLSearchParams();
  if (mode === "event") query.set("event", "1");
  if (mode === "event" && host) query.set("host", host);
  query.set(STAFF_BOARD_LINK_PARAM, signature);
  return `/tv?${query}`;
}

async function isStaffBoardLink(signature: string | string[] | undefined, mode: BoardMode): Promise<boolean> {
  if (typeof signature !== "string") return false;
  const key = secret();
  try {
    const { payload } = await jwtVerify(signature, key, { algorithms: ["HS256"], audience: LINK_AUDIENCE });
    return payload.mode === mode;
  } catch {
    return false;
  }
}

/**
 * The ticket for a /tv page the server is rendering, under a board id of its
 * own, or null for a page the monitor must not hear from: one not opened from
 * a staff link for its mode.
 */
export async function pageBoardTicket(page: {
  mode: BoardMode;
  host: string | null;
  link: string | string[] | undefined;
}): Promise<string | null> {
  if (!(await isStaffBoardLink(page.link, page.mode))) return null;
  return mintBoardTicket({ boardId: randomUUID(), mode: page.mode, host: page.host });
}
