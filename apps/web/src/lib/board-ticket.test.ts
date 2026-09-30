import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVENT_BOARD_LINK_PARAM,
  eventBoardLink,
  mintBoardTicket,
  pageBoardTicket,
  verifyBoardTicket,
} from "./board-ticket";

/**
 * The ticket is the only thing standing between a public route and the
 * venue's event mode, so what must hold: it verifies only as the board, mode
 * and host it was minted for; a ticket signed with another secret, for
 * another audience (a staff session), naming an unlisted host, or expired,
 * does not verify. And a rendered /tv page gets an event ticket only when it
 * was opened from the staff link: the public event view, a forged or expired
 * link, or a board ticket passed off as one, gets none.
 */

const BOARD = "0b9c5b1e-6a3f-4a55-9a52-3f1c2d7e8a10";
const SECRET = "board-ticket-test-secret";

beforeEach(() => vi.stubEnv("SESSION_SECRET", SECRET));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function sign(claims: Record<string, unknown>, options: { audience?: string; secret?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(BOARD)
    .setAudience(options.audience ?? "tv-board")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(options.secret ?? SECRET));
}

describe("board tickets", () => {
  it("round-trips the board, mode and host", async () => {
    const ticket = await mintBoardTicket({ boardId: BOARD, mode: "event", host: "cadillac" });
    await expect(verifyBoardTicket(ticket)).resolves.toEqual({ boardId: BOARD, mode: "event", host: "cadillac" });
    const wall = await mintBoardTicket({ boardId: BOARD, mode: "rotation", host: null });
    await expect(verifyBoardTicket(wall)).resolves.toEqual({ boardId: BOARD, mode: "rotation", host: null });
  });

  it("refuses a forgery, another secret's ticket, a staff session and an unlisted host", async () => {
    await expect(verifyBoardTicket("not-a-ticket")).resolves.toBeNull();
    await expect(verifyBoardTicket(await sign({ mode: "event", host: null }, { secret: "other" }))).resolves.toBeNull();
    await expect(verifyBoardTicket(await sign({ name: "Cody" }, { audience: "staff" }))).resolves.toBeNull();
    await expect(verifyBoardTicket(await sign({ mode: "event", host: "evilcorp" }))).resolves.toBeNull();
    await expect(verifyBoardTicket(await sign({ mode: "party", host: null }))).resolves.toBeNull();
  });

  it("expires after 36 hours", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-04T12:00:00Z") });
    const ticket = await mintBoardTicket({ boardId: BOARD, mode: "event", host: null });
    vi.setSystemTime(Date.parse("2026-10-05T23:59:00Z"));
    await expect(verifyBoardTicket(ticket)).resolves.not.toBeNull();
    vi.setSystemTime(Date.parse("2026-10-06T00:00:01Z"));
    await expect(verifyBoardTicket(ticket)).resolves.toBeNull();
  });
});

describe("the tickets a rendered /tv page gets", () => {
  /** The staff link's signature, as the page reads it off its URL. */
  async function linkSignature(host: string | null = null): Promise<string> {
    const url = new URL(await eventBoardLink(host), "https://oasis.example");
    expect(url.pathname).toBe("/tv");
    expect(url.searchParams.get("event")).toBe("1");
    expect(url.searchParams.get("host")).toBe(host);
    return url.searchParams.get(EVENT_BOARD_LINK_PARAM)!;
  }

  it("gives the event board opened from the staff link an event ticket, under a fresh board id", async () => {
    const link = await linkSignature("cadillac");
    const first = await verifyBoardTicket((await pageBoardTicket({ mode: "event", host: "cadillac", link }))!);
    const second = await verifyBoardTicket((await pageBoardTicket({ mode: "event", host: "cadillac", link }))!);
    expect(first).toMatchObject({ mode: "event", host: "cadillac" });
    expect(second!.boardId).not.toBe(first!.boardId);
  });

  it("gives the public event view none, whatever it passes off as the link", async () => {
    const boardTicket = await mintBoardTicket({ boardId: BOARD, mode: "event", host: null });
    const otherSecret = await sign({}, { audience: "tv-event-link", secret: "other" });
    for (const link of [undefined, "", "garbage", boardTicket, otherSecret, [await linkSignature(), "x"]]) {
      await expect(pageBoardTicket({ mode: "event", host: null, link })).resolves.toBeNull();
    }
  });

  it("stops opening event boards 48 hours after the link was made", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-03T12:00:00Z") });
    const link = await linkSignature();
    vi.setSystemTime(Date.parse("2026-10-05T11:59:00Z"));
    await expect(pageBoardTicket({ mode: "event", host: null, link })).resolves.not.toBeNull();
    vi.setSystemTime(Date.parse("2026-10-05T12:00:01Z"));
    await expect(pageBoardTicket({ mode: "event", host: null, link })).resolves.toBeNull();
  });

  it("gives the shop wall its ticket without a link", async () => {
    const ticket = await pageBoardTicket({ mode: "rotation", host: null, link: undefined });
    await expect(verifyBoardTicket(ticket!)).resolves.toMatchObject({ mode: "rotation", host: null });
  });
});
