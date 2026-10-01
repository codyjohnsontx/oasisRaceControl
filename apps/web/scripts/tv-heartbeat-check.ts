/**
 * Proves the event board's heartbeat end to end, in a real browser against a
 * real server, the four ways the rig monitor needs it to behave:
 *
 * - the public `/tv` and `/tv?event=1` send nothing, so no stranger's page
 *   can hold event mode or raise an alert;
 * - the event board opened from the staff link heartbeats on its 30-second
 *   cadence;
 * - closing the tab sends a goodbye, and no "board went dark" alert follows;
 * - killing the browser outright sends nothing, and three minutes later the
 *   monitor opens exactly that alert.
 *
 * Runs in the system's Google Chrome through `playwright-core`, like
 * `tv-event-scroll-check.ts`. The server must be a production build
 * (`npm run build && npm run start`, see AGENTS.md) started with
 * `SESSION_SECRET` and `CRON_SECRET`, and **without** `DISCORD_WEBHOOK_URL`,
 * or the alerts this provokes go to the venue's channel. The script signs the
 * staff link itself, so it needs the server's `SESSION_SECRET`. It reads the
 * server's database to see what the heartbeats stored - `DATABASE_URL` must
 * be the one the server uses, and a disposable one: it only reads, but it
 * waits on the monitor, which writes. It calls `/api/monitor/tick` with
 * `CRON_SECRET` to evaluate on demand. Takes about eight minutes, most of it
 * waiting out the three-minute dark threshold twice.
 *
 * Usage:
 *   DATABASE_URL=... CRON_SECRET=... SESSION_SECRET=... npx tsx scripts/tv-heartbeat-check.ts
 *     [--origin http://localhost:3000]
 *
 * Exits non-zero on the first check that fails.
 */
import { chromium, type Page } from "playwright-core";
import { Pool } from "pg";
import { staffBoardLink } from "../src/lib/board-ticket";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const origin = arg("origin", "http://localhost:3000");
const databaseUrl = process.env.DATABASE_URL;
const cronSecret = process.env.CRON_SECRET;

/** BOARD_HEARTBEAT_INTERVAL_MS and BOARD_DARK_AFTER_MS in src/lib/monitor/event-mode.ts. */
const INTERVAL_MS = 30_000;
const DARK_AFTER_MS = 3 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function expect(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}

type BoardRow = { board_id: string; closed: boolean; heard_s_ago: number };

async function newBoards(db: Pool, since: Date): Promise<BoardRow[]> {
  const { rows } = await db.query<BoardRow>(
    `select board_id::text, closed_at is not null as closed,
            extract(epoch from now() - last_seen_at)::float8 as heard_s_ago
     from board_heartbeats where mode = 'event' and first_seen_at >= $1 order by first_seen_at`,
    [since],
  );
  return rows;
}

async function darkAlerts(db: Pool, since: Date): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    "select count(*)::int as n from monitor_alerts where rule = 'board_dark' and opened_at >= $1",
    [since],
  );
  return rows[0]!.n;
}

/** Evaluates now; retried past the monitor's 20-second throttle if it was just used. */
async function evaluate(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(new URL("/api/monitor/tick", origin), {
      headers: { authorization: `Bearer ${cronSecret}` },
    });
    const body = (await res.json()) as { status?: string; evaluated?: boolean };
    expect(res.ok && body.status === "ok", `tick answered ${res.status} ${JSON.stringify(body)}`);
    if (body.evaluated) return;
    await sleep(21_000);
  }
  throw new Error("the tick never got an evaluation past the throttle");
}

/** Opens `url` and returns the times of the heartbeats it sends. */
async function open(page: Page, url: string): Promise<number[]> {
  const beats: number[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/tv/heartbeat") {
      beats.push(Date.now());
    }
  });
  await page.goto(url, { waitUntil: "load" });
  return beats;
}

async function cadence(page: Page, url: string, db: Pool, since: Date): Promise<void> {
  const beats = await open(page, url);
  await sleep(2 * INTERVAL_MS + 5_000);
  expect(beats.length >= 3, `expected 3 heartbeats in ${(2 * INTERVAL_MS + 5_000) / 1000}s, saw ${beats.length}`);
  const gaps = beats.slice(1).map((t, i) => t - beats[i]!);
  expect(
    gaps.every((gap) => Math.abs(gap - INTERVAL_MS) < 3_000),
    `heartbeats not every ${INTERVAL_MS / 1000}s: ${gaps.map((g) => `${(g / 1000).toFixed(1)}s`).join(", ")}`,
  );
  const boards = await newBoards(db, since);
  expect(boards.length === 1 && !boards[0]!.closed, `expected one open event board, found ${JSON.stringify(boards)}`);
  console.log(`cadence: ok - ${beats.length} heartbeats, ${gaps.map((g) => `${(g / 1000).toFixed(1)}s`).join(", ")} apart`);
}

async function main() {
  expect(
    Boolean(databaseUrl && cronSecret && process.env.SESSION_SECRET),
    "set DATABASE_URL, CRON_SECRET and SESSION_SECRET to the server's own",
  );
  const url = new URL(await staffBoardLink("event", null), origin).toString();
  const db = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    // 0. The public pages show the board and report nothing.
    let since = (await db.query<{ now: Date }>("select now()")).rows[0]!.now;
    const watcher = await chromium.launch({ channel: "chrome", headless: true });
    try {
      for (const path of ["/tv", "/tv?event=1"]) {
        const beats = await open(await watcher.newPage(), new URL(path, origin).toString());
        await sleep(5_000);
        expect(beats.length === 0, `the public ${path} sent ${beats.length} heartbeat(s)`);
      }
    } finally {
      await watcher.close();
    }
    const stray = await newBoards(db, since);
    expect(stray.length === 0, `the public event view stored a board: ${JSON.stringify(stray)}`);
    console.log("public: ok - no heartbeat from /tv or /tv?event=1");

    // 1. Cadence, then a closed tab: goodbye, and no alert past the threshold.
    since = (await db.query<{ now: Date }>("select now()")).rows[0]!.now;
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const page = await browser.newPage();
      await cadence(page, url, db, since);
      await page.close({ runBeforeUnload: true });
    } finally {
      await browser.close();
    }
    await sleep(2_000);
    const closed = await newBoards(db, since);
    expect(closed.length === 1 && closed[0]!.closed, `closing the tab sent no goodbye: ${JSON.stringify(closed)}`);
    console.log("close: goodbye stored; waiting out the dark threshold...");
    await sleep(DARK_AFTER_MS + 15_000);
    await evaluate();
    expect((await darkAlerts(db, since)) === 0, "closing the tab opened a board-dark alert");
    console.log("close: ok - no alert");

    // 2. A killed browser: no goodbye, and the alert once the threshold passes.
    since = (await db.query<{ now: Date }>("select now()")).rows[0]!.now;
    const server = await chromium.launchServer({ channel: "chrome", headless: true });
    const killed = await chromium.connect(server.wsEndpoint());
    const page = await killed.newPage();
    const beats = await open(page, url);
    for (let waited = 0; beats.length === 0 && waited < 15_000; waited += 500) await sleep(500);
    expect(beats.length > 0, "the second board never heartbeat");
    await sleep(2_000);
    await server.kill();
    await sleep(2_000);
    const killedRows = await newBoards(db, since);
    expect(
      killedRows.length === 1 && !killedRows[0]!.closed,
      `a killed browser should say nothing, found ${JSON.stringify(killedRows)}`,
    );
    console.log("kill: no goodbye; waiting out the dark threshold...");
    await sleep(DARK_AFTER_MS + 15_000);
    await evaluate();
    expect((await darkAlerts(db, since)) === 1, "killing the browser did not open a board-dark alert");
    console.log("kill: ok - one board-dark alert");
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(`FAIL ${(error as Error).message}`);
  process.exit(1);
});
