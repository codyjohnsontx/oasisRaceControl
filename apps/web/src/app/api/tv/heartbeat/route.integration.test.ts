import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mintBoardTicket } from "@/lib/board-ticket";
import { closeTestDb, describeDb, resetDb, testDb } from "@/test/db";

/**
 * The board heartbeat against real Postgres: a page's heartbeats keep one row,
 * its goodbye closes it, a heartbeat that was still in flight as it closed
 * does not reopen it, and the same page saying it was restored from the
 * back-forward cache does. The evaluation it schedules is the
 * monitor's, tested in src/lib/monitor/monitor.integration.test.ts.
 */

vi.mock("@/lib/monitor/run", () => ({ scheduleMonitor: () => {} }));

const { POST } = await import("./route");

function post(body: unknown) {
  return new Request("http://localhost/api/tv/heartbeat", {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8", "x-forwarded-for": "198.51.100.4" },
    body: JSON.stringify(body),
  });
}

async function row(boardId: string) {
  const { rows } = await testDb().query<{
    mode: string;
    host: string | null;
    feed_ok: boolean | null;
    feed_failures: number;
    closed: boolean;
    heard_after_first: boolean;
  }>(
    `select mode, host, feed_ok, feed_failures, closed_at is not null as closed,
            last_seen_at > first_seen_at as heard_after_first
     from board_heartbeats where board_id = $1`,
    [boardId],
  );
  return rows;
}

describeDb("POST /api/tv/heartbeat against real Postgres", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("keeps one row per page: heartbeats update it, a goodbye closes it, a return reopens it", async () => {
    const boardId = randomUUID();
    const ticket = await mintBoardTicket({ boardId, mode: "event", host: "cadillac" });

    expect((await POST(post({ ticket, visible: true, feedOk: null, feedFailures: 0 }))).status).toBe(200);
    expect(await row(boardId)).toEqual([
      { mode: "event", host: "cadillac", feed_ok: null, feed_failures: 0, closed: false, heard_after_first: false },
    ]);

    expect((await POST(post({ ticket, visible: true, feedOk: false, feedFailures: 4 }))).status).toBe(200);
    expect(await row(boardId)).toMatchObject([{ feed_ok: false, feed_failures: 4, closed: false, heard_after_first: true }]);

    await POST(post({ ticket, visible: false, feedOk: false, feedFailures: 4, closing: true }));
    expect(await row(boardId)).toMatchObject([{ closed: true }]);

    await POST(post({ ticket, visible: true, feedOk: true, feedFailures: 0, reopened: true }));
    expect(await row(boardId)).toMatchObject([{ feed_ok: true, feed_failures: 0, closed: false }]);
  });

  it("keeps a board restored from the back-forward cache open when its old goodbye lands late", async () => {
    // The page's goodbye is a beacon and its heartbeats are fetches, and the
    // two keep no order: the goodbye sent as it left can reach the server
    // after its first heartbeat back. The page says reopened on every
    // heartbeat after a restore, so the next one undoes that late goodbye.
    const boardId = randomUUID();
    const ticket = await mintBoardTicket({ boardId, mode: "event", host: null });
    const beat = { ticket, visible: true, feedOk: true, feedFailures: 0 };

    await POST(post(beat));
    await POST(post({ ...beat, visible: false, closing: true }));
    await POST(post({ ...beat, reopened: true }));
    expect(await row(boardId)).toMatchObject([{ closed: false }]);

    // The goodbye from before the restore, delivered late.
    await POST(post({ ...beat, visible: false, closing: true }));
    expect(await row(boardId)).toMatchObject([{ closed: true }]);

    // The restored page's next periodic heartbeat still says reopened.
    await POST(post({ ...beat, reopened: true }));
    expect(await row(boardId)).toMatchObject([{ closed: false }]);
  });

  it("keeps a closed board closed when an ordinary heartbeat lands after its goodbye", async () => {
    const boardId = randomUUID();
    const ticket = await mintBoardTicket({ boardId, mode: "event", host: null });

    expect((await POST(post({ ticket, visible: true, feedOk: true, feedFailures: 0 }))).status).toBe(200);
    await POST(post({ ticket, visible: false, feedOk: true, feedFailures: 0, closing: true }));
    expect((await POST(post({ ticket, visible: true, feedOk: true, feedFailures: 0 }))).status).toBe(200);
    expect(await row(boardId)).toMatchObject([{ closed: true }]);
  });
});
