import { tvHostLogo } from "@/lib/tv-host-logo";

/**
 * The TV boards as the monitor sees them, and event mode, which they switch.
 * Pure, like the rules: the alerts, the 20-minute update and the staff Rig
 * health page all call these on the same snapshot, so none of them can
 * disagree about whether the venue is mid-event.
 *
 * Event mode is on while an event board is open and heard from - opening the
 * board is already part of setting up an event, so nobody has to remember a
 * second step (owner's decision R8). An event board is one opened from the
 * staff link (lib/board-ticket.ts): the public /tv?event=1 view is only
 * watched, never reported, so a stranger cannot switch the venue's channel.
 * Staff can force it on or off; the
 * override lasts until venue midnight and no longer, because a takeover the
 * venue day does not bound owns the channel until somebody notices
 * (AGENTS.md, the /tv board rotation).
 */

/** How often an open /tv page reports (components/tv/board-heartbeat.tsx). */
export const BOARD_HEARTBEAT_INTERVAL_MS = 30_000;
/**
 * A board not heard from for this long, without a goodbye, went dark. Six
 * missed heartbeats: a hidden tab's timers can be throttled to one a minute,
 * so fewer would read a minimised browser as a dead one.
 */
export const BOARD_DARK_AFTER_MS = 3 * 60_000;
/**
 * A board that said goodbye this recently still holds event mode, so reloading
 * the event board - a goodbye, then a new page's first heartbeat a second
 * later - does not post "event mode off" and "on" again.
 */
export const BOARD_RELOAD_GRACE_MS = 2 * 60_000;

export type BoardMode = "rotation" | "event";

export type BoardSnapshot = {
  id: string;
  mode: BoardMode;
  /** The event host's key (lib/tv-host-logo.ts), when the link named one. */
  host: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  visible: boolean | null;
  /** Whether its last load of the numbers succeeded; null before the first. */
  feedOk: boolean | null;
  /** Loads that failed in a row. */
  feedFailures: number;
  closedAt: number | null;
};

export type EventModeOverride = {
  mode: "on" | "off";
  expiresAt: number;
  /** The staff member who set it, by display name. */
  setBy: string | null;
};

export type EventModeInput = {
  now: number;
  /** When the current venue day began (venue-local midnight), on the database's clock. */
  venueDayStart: number;
  override: EventModeOverride | null;
  boards: readonly BoardSnapshot[];
  /**
   * When the channel was told event mode came on, or null while it was last
   * told off - so the evaluation that turns it on finds it began just now.
   */
  eventModeSince: number | null;
};

export type EventMode =
  | { on: boolean; cause: "override"; setBy: string | null; expiresAt: number }
  | { on: true; cause: "board"; board: BoardSnapshot }
  | { on: false; cause: "none" };

export function eventMode(input: EventModeInput): EventMode {
  const { override } = input;
  if (override && override.expiresAt > input.now) {
    return {
      on: override.mode === "on",
      cause: "override",
      setBy: override.setBy,
      expiresAt: override.expiresAt,
    };
  }
  // Newest first, so the board named is the one most recently heard.
  const board = boardsToday(input)
    .filter((b) => b.mode === "event" && holdsEventMode(b, input.now))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
  return board ? { on: true, cause: "board", board } : { on: false, cause: "none" };
}

/** When the event mode now on began, or null while it is off. */
export function eventModeBegan(input: EventModeInput): number | null {
  return eventMode(input).on ? (input.eventModeSince ?? input.now) : null;
}

/**
 * An event board holds event mode while it is live, and for a reload's grace
 * after its goodbye. A board that went dark stops holding it: a phone left
 * locked on the board must not keep the venue mid-event until midnight. The
 * dark board is still reported, by rule 8a, which does not wait on event mode.
 */
function holdsEventMode(board: BoardSnapshot, now: number): boolean {
  return board.closedAt === null
    ? boardState(board, now) === "live"
    : now - board.closedAt < BOARD_RELOAD_GRACE_MS;
}

export type BoardState = "live" | "dark" | "closed";

export function boardState(board: BoardSnapshot, now: number): BoardState {
  if (board.closedAt !== null) return "closed";
  return now - board.lastSeenAt <= BOARD_DARK_AFTER_MS ? "live" : "dark";
}

/** Boards heard from since the venue day began; anything older is yesterday's. */
export function boardsToday(input: Pick<EventModeInput, "venueDayStart" | "boards">): BoardSnapshot[] {
  return input.boards.filter((b) => b.lastSeenAt >= input.venueDayStart);
}

/**
 * The display the room is watching: today's event boards, or, while staff
 * have forced event mode on with none of them still open (an event run on
 * the shop wall), the shop wall's - one heard since event mode began, or
 * still live when it began, so a wall already dark by then is not the event's
 * display. On an ordinary day the wall is nobody's event display.
 */
export function eventDisplays(input: EventModeInput): BoardSnapshot[] {
  const today = boardsToday(input);
  const event = today.filter((b) => b.mode === "event");
  const mode = eventMode(input);
  if (mode.cause !== "override" || !mode.on || event.some((b) => b.closedAt === null)) return event;
  const began = eventModeBegan(input)!;
  return today.filter((b) => b.mode === "rotation" && b.lastSeenAt >= began - BOARD_DARK_AFTER_MS);
}

/** "Event board (Cadillac)", "Shop wall board". */
export function boardName(board: Pick<BoardSnapshot, "mode" | "host">): string {
  if (board.mode === "rotation") return "Shop wall board";
  const host = board.host ? (tvHostLogo(board.host)?.alt ?? board.host) : null;
  return host ? `Event board (${host})` : "Event board";
}
