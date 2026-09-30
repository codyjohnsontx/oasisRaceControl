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
 * Event mode is on while an event board is open and heard from, and staff can
 * force it either way until venue midnight. What must hold: a board not heard
 * from for three minutes no longer holds it (a phone left locked on the board
 * must not keep the venue mid-event), a goodbye ends it - but not a reload's
 * goodbye - yesterday's boards count for nothing, and an override that has
 * lapsed is ignored to the millisecond.
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
  return { now: NOW, venueDayStart: DAY_START, override: null, boards: [], eventModeSince: null, ...overrides };
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

  it("is held only by a board heard from within three minutes, not by one gone dark without a goodbye", () => {
    const last = board({ lastSeenAt: NOW - BOARD_DARK_AFTER_MS });
    const dark = board({ lastSeenAt: NOW - BOARD_DARK_AFTER_MS - 1 });
    expect(eventMode(input({ boards: [last] })).on).toBe(true);
    expect(boardState(dark, NOW)).toBe("dark");
    expect(eventMode(input({ boards: [dark] }))).toEqual({ on: false, cause: "none" });
    expect(eventMode(input({ boards: [dark, board({ id: "live" })] }))).toMatchObject({ board: { id: "live" } });
  });

  it("ends on the board's goodbye, once a reload's grace has passed", () => {
    const reloading = board({ closedAt: NOW - BOARD_RELOAD_GRACE_MS + 1 });
    const closed = board({ closedAt: NOW - BOARD_RELOAD_GRACE_MS });
    expect(eventMode(input({ boards: [reloading] })).on).toBe(true);
    expect(eventMode(input({ boards: [closed] })).on).toBe(false);
  });

  it("stays on across venue midnight for a board heard within the live window before it", () => {
    // 00:00:10 venue time, a board last heard at 23:59:50.
    const justAfter = DAY_START + 10_000;
    const heard = board({ lastSeenAt: DAY_START - 10_000 });
    expect(eventMode(input({ now: justAfter, boards: [heard] }))).toMatchObject({ on: true, cause: "board" });
  });

  it("lets midnight change nothing: yesterday's board holds only while it is within the live window", () => {
    const justAfter = input({ now: DAY_START + MIN });
    const lastHeard = (at: number) => eventMode({ ...justAfter, boards: [board({ lastSeenAt: at })] }).on;
    expect(lastHeard(DAY_START + MIN - BOARD_DARK_AFTER_MS)).toBe(true);
    expect(lastHeard(DAY_START + MIN - BOARD_DARK_AFTER_MS - 1)).toBe(false);
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

  it("takes today's event boards as the event's display, or the shop wall while event mode is on without one", () => {
    const wall = board({ id: "wall", mode: "rotation", host: null });
    const event = board({ id: "event" });
    const yesterdaysEvent = board({ id: "old", lastSeenAt: DAY_START - MIN });
    const on = { mode: "on" as const, expiresAt: NOW + MIN, setBy: "Cody" };
    expect(eventDisplays(input({ boards: [wall, event] })).map((b) => b.id)).toEqual(["event"]);
    expect(eventDisplays(input({ boards: [wall, event], override: on })).map((b) => b.id)).toEqual(["event"]);
    expect(eventDisplays(input({ boards: [wall, yesterdaysEvent], override: on })).map((b) => b.id)).toEqual(["wall"]);
    expect(eventDisplays(input({ boards: [wall, yesterdaysEvent] }))).toEqual([]);
  });

  it("falls back to the shop wall when today's event boards are all closed, not only when there are none", () => {
    const wall = board({ id: "wall", mode: "rotation", host: null });
    const closed = board({ id: "closed", closedAt: NOW - 60 * MIN, lastSeenAt: NOW - 60 * MIN });
    const on = { mode: "on" as const, expiresAt: NOW + MIN, setBy: "Cody" };
    expect(eventDisplays(input({ boards: [wall, closed], override: on })).map((b) => b.id)).toEqual(["wall"]);
    const lockedPhone = board({ id: "phone", lastSeenAt: NOW - 90 * MIN });
    expect(eventDisplays(input({ boards: [wall, closed, lockedPhone], override: on })).map((b) => b.id)).toEqual([
      "closed",
      "phone",
    ]);
  });

  it("does not take a shop wall already dark when event mode began as the event's display", () => {
    const on = { mode: "on" as const, expiresAt: NOW + MIN, setBy: "Cody" };
    const began = NOW - 30 * MIN;
    const darkBefore = board({ id: "wall", mode: "rotation", host: null, lastSeenAt: began - BOARD_DARK_AFTER_MS - 1 });
    const liveWhenBegan = board({ id: "wall", mode: "rotation", host: null, lastSeenAt: began - BOARD_DARK_AFTER_MS });
    expect(eventDisplays(input({ boards: [darkBefore], override: on, eventModeSince: began }))).toEqual([]);
    expect(eventDisplays(input({ boards: [liveWhenBegan], override: on, eventModeSince: began }))).toHaveLength(1);
  });

  it("names a board by its host, as the host's own name", () => {
    expect(boardName({ mode: "event", host: "cadillac" })).toBe("Event board (Cadillac)");
    expect(boardName({ mode: "event", host: null })).toBe("Event board");
    expect(boardName({ mode: "rotation", host: null })).toBe("Shop wall board");
  });
});
