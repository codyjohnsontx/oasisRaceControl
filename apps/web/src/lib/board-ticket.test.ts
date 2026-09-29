import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintBoardTicket, verifyBoardTicket } from "./board-ticket";

/**
 * The ticket is the only thing standing between a public route and the
 * venue's event mode, so what must hold: it verifies only as the board, mode
 * and host it was minted for; a ticket signed with another secret, for
 * another audience (a staff session), naming an unlisted host, or expired,
 * does not verify.
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
