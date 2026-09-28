/**
 * Drives the event view's list (`/tv?event=1`, `auto-scroll.tsx`) by hand the
 * ways a projected touch screen can reach it, and proves each one takes the
 * list over, moves it, and gives it back to the automatic scroll twenty
 * seconds after the last interaction:
 *
 * - a finger, as real touch input (CDP `Input.synthesizeScrollGesture` with
 *   `gestureSourceType: "touch"`), which the browser pans natively;
 * - a mouse wheel;
 * - a mouse press-and-drag, which is what a touch display on a Mac sends -
 *   including that a button held still on the list keeps it in hand past the
 *   twenty seconds, and that the clock starts from the release;
 * - a plain click, which takes the list over and moves nothing.
 *
 * Runs against a live server in the system's Google Chrome through
 * `playwright-core`, like `tv-corner-check.ts`. The featured combo needs
 * enough laps today for the list to overflow the screen, or there is nothing
 * to scroll and the check says so. Takes a little over two minutes, most of
 * it waiting out the idle resume.
 *
 * Usage (production build already running, see README):
 *   npx tsx scripts/tv-event-scroll-check.ts [--url http://localhost:3000/tv?event=1]
 *     [--viewport 1272x601]
 *
 * Exits non-zero on the first check that fails.
 */
import { chromium, type Page } from "playwright-core";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const url = arg("url", "http://localhost:3000/tv?event=1");
const [width, height] = arg("viewport", "1272x601").split("x").map(Number);

/** `IDLE_RESUME_MS` in `auto-scroll.tsx`, the twenty seconds the owner was told. */
const IDLE_RESUME_MS = 20_000;
const FRAME = "[data-tv-auto-scroll]";
const DISTANCE = 200;

type State = { held: boolean; animating: boolean; top: number; max: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function state(page: Page): Promise<State> {
  return page.$eval(FRAME, (el) => ({
    held: el.hasAttribute("data-tv-auto-scroll-held"),
    animating: el.querySelector(".tv-auto-scroll") !== null,
    top: el.scrollTop,
    max: el.scrollHeight - el.clientHeight,
  }));
}

function expect(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}

async function center(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator(FRAME).boundingBox();
  if (!box) throw new Error("the list has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A fresh page with the list scrolling on its own. */
async function fresh(page: Page): Promise<void> {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.locator(FRAME).waitFor({ timeout: 15_000 });
  const overflowing = await page
    .locator(`${FRAME}.tv-auto-scroll-frame`)
    .waitFor({ timeout: 5_000 })
    .then(() => true, () => false);
  expect(overflowing, "the list fits on screen, so there is nothing to scroll - add laps to the featured combo today");
  const s = await state(page);
  expect(s.animating && !s.held, "the list is not scrolling on its own after load");
}

/** Which way `DISTANCE` of scrolling fits from here: +1 further down the list, -1 back up. */
function direction(s: State): 1 | -1 {
  return s.top + DISTANCE <= s.max ? 1 : -1;
}

function expectMoved(label: string, before: State, after: State, dir: 1 | -1): void {
  const moved = (after.top - before.top) * dir;
  expect(
    moved > DISTANCE / 2,
    `${label}: the list moved ${Math.round(after.top - before.top)}px, expected about ${dir * DISTANCE}px`,
  );
}

/**
 * Still in hand just short of the idle time counted from `since`, and back on
 * its own, from the top, shortly after it.
 */
async function expectResume(page: Page, label: string, since: number): Promise<void> {
  await sleep(since + IDLE_RESUME_MS - 2_000 - Date.now());
  expect((await state(page)).held, `${label}: gave the list back before ${IDLE_RESUME_MS / 1000}s untouched`);
  await page
    .waitForFunction((sel) => !document.querySelector(sel)?.hasAttribute("data-tv-auto-scroll-held"), FRAME, {
      timeout: 5_000,
    })
    .catch(() => {
      throw new Error(`${label}: still in hand ${IDLE_RESUME_MS / 1000 + 3}s after the last interaction`);
    });
  const s = await state(page);
  expect(s.animating && s.top === 0, `${label}: resumed, but not scrolling on its own from the top`);
  console.log(`${label}: ok - resumed ${IDLE_RESUME_MS / 1000}s after the last interaction`);
}

async function touch(page: Page): Promise<void> {
  await fresh(page);
  const cdp = await page.context().newCDPSession(page);
  const at = await center(page);
  const swipe = (dir: 1 | -1) =>
    cdp.send("Input.synthesizeScrollGesture", {
      ...at,
      yDistance: -dir * DISTANCE,
      speed: 800,
      gestureSourceType: "touch",
    });
  await swipe(1);
  expect((await state(page)).held, "touch: the first swipe did not take the list over");
  const before = await state(page);
  const dir = direction(before);
  await swipe(dir);
  await sleep(500);
  expectMoved("touch", before, await state(page), dir);
  const since = Date.now();
  console.log("touch: ok - a finger pans the list");
  await expectResume(page, "touch", since);
}

async function wheel(page: Page): Promise<void> {
  await fresh(page);
  const at = await center(page);
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, DISTANCE);
  await sleep(500);
  expect((await state(page)).held, "wheel: the wheel did not take the list over");
  const before = await state(page);
  const dir = direction(before);
  await page.mouse.wheel(0, dir * DISTANCE);
  await sleep(800);
  expectMoved("wheel", before, await state(page), dir);
  const since = Date.now();
  console.log("wheel: ok - the wheel scrolls the list");
  await expectResume(page, "wheel", since);
}

async function click(page: Page): Promise<void> {
  await fresh(page);
  const at = await center(page);
  await page.mouse.click(at.x, at.y);
  const before = await state(page);
  expect(before.held, "click: a click did not take the list over");
  await sleep(1_000);
  const after = await state(page);
  expect(after.top === before.top, `click: the list moved ${after.top - before.top}px on a plain click`);
  console.log("click: ok - a click takes the list over and moves nothing");
}

async function drag(page: Page): Promise<void> {
  await fresh(page);
  const at = await center(page);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  const before = await state(page);
  expect(before.held, "drag: the press did not take the list over");
  const dir = direction(before);
  // The list follows the pointer, so moving up scrolls further down it.
  await page.mouse.move(at.x, at.y - dir * DISTANCE, { steps: 10 });
  await sleep(200);
  const after = await state(page);
  expectMoved("drag", before, after, dir);
  expect(
    Math.abs(after.top - before.top - dir * DISTANCE) <= 2,
    `drag: the list moved ${after.top - before.top}px for a ${dir * DISTANCE}px drag`,
  );
  console.log("drag: ok - a mouse press-and-drag scrolls the list with the pointer");

  // Held still on the list past the idle time: still somebody's.
  await sleep(IDLE_RESUME_MS + 2_000);
  expect((await state(page)).held, "drag: gave the list back while the button was still down");
  console.log(`drag: ok - a button held still keeps the list past ${IDLE_RESUME_MS / 1000}s`);
  await page.mouse.up();
  await expectResume(page, "drag", Date.now());
}

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: true });
    await click(page);
    await touch(page);
    await wheel(page);
    await drag(page);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`FAIL ${(error as Error).message}`);
  process.exit(1);
});
