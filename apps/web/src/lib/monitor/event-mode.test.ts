import { describe, expect, it } from "vitest";
import {
  BOARD_DARK_AFTER_MS,
  BOARD_RELOAD_GRACE_MS,
  boardName,
  boardState,
  eventDisplays,
  eventMode,
  type BoardSnapshot,
  type EventModeInput,
} from "./event-mode";

/**
 * Event mode is on while an event board is open, and staff can force it either
 * way until venue midnight. What must hold: a board that went dark keeps the
 * event on (or rule 8a could never fire), a goodbye ends it - but not a
 * reload's goodbye - yesterday's boards count for nothing, and an override
 * that has lapsed is ignored to the millisecond.
 */

const NOW = Date.parse("2026-10-04T21:00:00Z");
const MIN = 60_000;
/** 2026-10-04 began at 05:00Z in the venue's zone (CDT). */
const DAY_START = Date.parse("2026-10-04T05:00:00Z");

function board(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    id: "board-1",
    mode: "event",
    host: "cadillac",
    firstSeenAt: NOW - 60 * MIN,
    lastSeenAt: NOW - 20_000,
    visible: true,
    feedOk: true,
    feedFailures: 0,
    closedAt: null,
    ...overrides,
  };
}

function input(overrides: Partial<EventModeInput> = {}): EventModeInput {
  return { now: NOW, venueDayStart: DAY_START, override: null, boards: [], ...overrides };
}

describe("eventMode", () => {
  it("is off with no board and no override", () => {
    expect(eventMode(input())).toEqual({ on: false, cause: "none" });
  });

  it("is on while an event board is open, naming the board most recently heard", () => {
    const older = board({ id: "older", lastSeenAt: NOW - 50_000 });
    const newer = board({ id: "newer" });
    const mode = eventMode(input({ boards: [older, newer] }));
    expect(mode).toMatchObject({ on: true, cause: "board", board: { id: "newer" } });
  });

  it("is not turned on by the shop wall's rotation board", () => {
    expect(eventMode(input({ boards: [board({ mode: "rotation" })] })).on).toBe(false);
  });

  it("stays on when the event board goes dark without a goodbye, so the dark board can be reported", () => {
    const dark = board({ lastSeenAt: NOW - 40 * MIN });
    expect(boardState(dark, NOW)).toBe("dark");
    expect(eventMode(input({ boards: [dark] })).on).toBe(true);
  });

  it("ends on the board's goodbye, once a reload's grace has passed", () => {
    const reloading = board({ closedAt: NOW - BOARD_RELOAD_GRACE_MS + 1 });
    const closed = board({ closedAt: NOW - BOARD_RELOAD_GRACE_MS });
    expect(eventMode(input({ boards: [reloading] })).on).toBe(true);
    expect(eventMode(input({ boards: [closed] })).on).toBe(false);
  });

  it("ends at venue midnight: a board last heard yesterday counts for nothing", () => {
    const yesterday = board({ lastSeenAt: DAY_START - 1 });
    expect(eventMode(input({ boards: [yesterday] })).on).toBe(false);
    expect(eventMode(input({ boards: [board({ lastSeenAt: DAY_START })] })).on).toBe(true);
  });

  it("follows a staff override over the boards until it expires, and the boards after", () => {
    const open = [board()];
    const off = { mode: "off" as const, expiresAt: NOW + 1, setBy: "Cody" };
    expect(eventMode(input({ boards: open, override: off }))).toEqual({
      on: false,
      cause: "override",
      setBy: "Cody",
      expiresAt: NOW + 1,
    });
    // Expired at exactly its instant: the boards decide again.
    expect(eventMode(input({ boards: open, override: { ...off, expiresAt: NOW } }))).toMatchObject({
      on: true,
      cause: "board",
    });

    const on = { mode: "on" as const, expiresAt: NOW + 1, setBy: null };
    expect(eventMode(input({ override: on }))).toMatchObject({ on: true, cause: "override" });
    expect(eventMode(input({ override: { ...on, expiresAt: NOW } }))).toEqual({ on: false, cause: "none" });
  });
});

describe("boards", () => {
  it("reads live, dark and closed from the last heartbeat and the goodbye", () => {
    expect(boardState(board({ lastSeenAt: NOW - BOARD_DARK_AFTER_MS }), NOW)).toBe("live");
    expect(boardState(board({ lastSeenAt: NOW - BOARD_DARK_AFTER_MS - 1 }), NOW)).toBe("dark");
    expect(boardState(board({ closedAt: NOW - 10 * MIN, lastSeenAt: NOW - 10 * MIN }), NOW)).toBe("closed");
  });

  it("takes today's event boards as the event's display, or the shop wall on a day with none", () => {
    const wall = board({ id: "wall", mode: "rotation", host: null });
    const event = board({ id: "event" });
    const yesterdaysEvent = board({ id: "old", lastSeenAt: DAY_START - MIN });
    expect(eventDisplays(input({ boards: [wall, event] })).map((b) => b.id)).toEqual(["event"]);
    expect(eventDisplays(input({ boards: [wall, yesterdaysEvent] })).map((b) => b.id)).toEqual(["wall"]);
  });

  it("names a board by its host, as the host's own name", () => {
    expect(boardName({ mode: "event", host: "cadillac" })).toBe("Event board (Cadillac)");
    expect(boardName({ mode: "event", host: null })).toBe("Event board");
    expect(boardName({ mode: "rotation", host: null })).toBe("Shop wall board");
  });
});
