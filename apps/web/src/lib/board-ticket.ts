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
 * Rendering the page is not proof enough for an event board, because anyone
 * can load /tv?event=1. An event board - the one that turns event mode on and
 * that rule 8a pages about - gets a ticket only when the page was opened from
 * the staff link (`eventBoardLink`, on /staff), which carries a signature of
 * its own. The public event view still shows the board to anyone; it just
 * reports nothing, so no stranger, curl or stray phone can switch the venue's
 * channel into event mode or page the owner.
 *
 * It lasts BOARD_TICKET_TTL_S and every accepted heartbeat renews it, so a
 * board left open for a whole event weekend keeps reporting; a page that has
 * not reached the site for that long has been dark for a day and a half, and
 * reloading it mints a new one.
 */

export const BOARD_TICKET_TTL_S = 36 * 60 * 60;
const AUDIENCE = "tv-board";

/**
 * How long a staff link opens an event board: a two-day event from its first
 * morning, so the laptop's board can be reloaded on day two. A board already
 * open keeps reporting past it, on its renewed ticket.
 */
export const EVENT_BOARD_LINK_TTL_S = 48 * 60 * 60;
const LINK_AUDIENCE = "tv-event-link";
/** The /tv search parameter the staff link's signature rides in. */
export const EVENT_BOARD_LINK_PARAM = "staff";

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

/** The /tv?event=1 link staff open the event board from, for a host or none. */
export async function eventBoardLink(host: string | null): Promise<string> {
  const signature = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(LINK_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${EVENT_BOARD_LINK_TTL_S}s`)
    .sign(secret());
  const query = new URLSearchParams({ event: "1" });
  if (host) query.set("host", host);
  query.set(EVENT_BOARD_LINK_PARAM, signature);
  return `/tv?${query}`;
}

async function isEventBoardLink(signature: string | string[] | undefined): Promise<boolean> {
  if (typeof signature !== "string") return false;
  const key = secret();
  try {
    await jwtVerify(signature, key, { algorithms: ["HS256"], audience: LINK_AUDIENCE });
    return true;
  } catch {
    return false;
  }
}

/**
 * The ticket for a /tv page the server is rendering, under a board id of its
 * own, or null for a page the monitor must not hear from: an event view not
 * opened from a staff link.
 */
export async function pageBoardTicket(page: {
  mode: BoardMode;
  host: string | null;
  link: string | string[] | undefined;
}): Promise<string | null> {
  if (page.mode === "event" && !(await isEventBoardLink(page.link))) return null;
  return mintBoardTicket({ boardId: randomUUID(), mode: page.mode, host: page.host });
}
