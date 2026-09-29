/**
 * Screenshots `/tv` and proves the QR code in the corner is fully on screen
 * and overlaps nothing: not a board row, not the board's header, not the rest
 * of the footer. It also decodes the hydrated code and fails unless it opens
 * the view's target - the Oasis website on the event view, the page's own
 * `/leaderboards` on the rotation - which no server-side test can see, since
 * the rotation's code is only drawn once the browser knows its origin. Then it
 * waits for the rotation to move and checks and screenshots the next boards
 * too, so the corner is proven on more than the board that happened to be up.
 *
 * Runs against a live server in the system's Google Chrome through
 * `playwright-core` - no browser download, and nothing in `npm test` needs a
 * server. The viewport defaults to the venue wall's 1272x601; pass a laptop
 * size to see what the owner's screen shows. Point `--url` at `/tv?event=1`
 * to check the event view: it has one board, so the wait for a second is
 * skipped on its own.
 *
 * It also checks the app-wide Screens button: shown on the rotation, hidden
 * on the event view, where any visitor could tap it through to the staff
 * sign-in. That is the CSS rule in `globals.css` meeting the page's
 * `data-tv-mode`, which only a browser can evaluate.
 *
 * Usage (server already running, see README):
 *   npx tsx scripts/tv-corner-check.ts [--url http://localhost:3000/tv]
 *     [--viewport 1272x601] [--out tv-corner.png] [--boards 2]
 *
 * Exits non-zero on the first overlap or clipped corner it finds.
 */
import { chromium, type Page } from "playwright-core";
import { tvMode } from "../src/lib/tv-rotation";
import { decodeQrMarkup } from "../src/test/decode-qr-markup";
import { OASIS_WEBSITE_URL, STANDINGS_PATH } from "../src/components/tv/phone-standings-qr";

type Box = { x: number; y: number; width: number; height: number };

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const url = arg("url", "http://localhost:3000/tv");
const [width, height] = arg("viewport", "1272x601").split("x").map(Number);
const out = arg("out", `tv-corner-${width}x${height}.png`);
const boards = Number(arg("boards", "2"));

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Every on-screen box the corner must keep clear of, with a name for the
 * report. Boxes are what is visible, not what is laid out: the event view's
 * rows scroll inside a clipped frame, so a row that is currently below the
 * fold is clipped to that frame (to nothing, if it is wholly out of view) -
 * otherwise every hidden row would "overlap" the footer under it.
 */
async function neighbours(page: Page): Promise<Array<{ name: string; box: Box }>> {
  const named: Array<{ name: string; box: Box }> = [];
  const add = async (selector: string, label: (i: number) => string) => {
    // One anonymous function with no nested named ones: this runs inside the
    // page, where the `__name` helper tsx wraps named functions in does not
    // exist.
    const boxes = await page.evaluate((sel: string) => {
      const out: Array<{ x: number; y: number; width: number; height: number } | null> = [];
      for (const el of Array.from(document.querySelectorAll(sel))) {
        let rect: DOMRect | null = el.getBoundingClientRect();
        for (let a = el.parentElement; rect && a; a = a.parentElement) {
          if (getComputedStyle(a).overflow === "visible") continue;
          const c = a.getBoundingClientRect();
          const x = Math.max(rect.left, c.left);
          const y = Math.max(rect.top, c.top);
          const right = Math.min(rect.right, c.right);
          const bottom = Math.min(rect.bottom, c.bottom);
          rect = right <= x || bottom <= y ? null : new DOMRect(x, y, right - x, bottom - y);
        }
        out.push(rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null);
      }
      return out;
    }, selector);
    for (const [i, box] of boxes.entries()) {
      if (box && box.width > 0 && box.height > 0) named.push({ name: label(i), box });
    }
  };
  await add("main section > header", () => "board header");
  await add("main section li", (i) => `row ${i + 1}`);
  await add("main footer > div > *:not(#tv-phone-qr)", (i) => `footer item ${i + 1}`);
  await add("main footer > div:first-child", () => "footer left group");
  return named;
}

async function check(page: Page, label: string): Promise<void> {
  const qr = page.locator("#tv-phone-qr");
  await qr.locator("svg path").waitFor({ timeout: 15_000 });
  const box = await qr.boundingBox();
  if (!box) throw new Error(`${label}: corner code has no box`);
  const inside =
    box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height;
  if (!inside) throw new Error(`${label}: corner code clipped by the viewport: ${JSON.stringify(box)}`);

  const svg = await qr.locator("svg").boundingBox();
  const problems: string[] = [];
  for (const { name, box: other } of await neighbours(page)) {
    if (overlaps(box, other)) problems.push(name);
  }
  if (problems.length > 0) {
    throw new Error(`${label}: corner code overlaps ${problems.join(", ")}`);
  }
  const footer = await page.locator("main footer p").first().textContent();
  console.log(
    `${label}: ok - ${footer?.trim()} - code ${Math.round(svg?.width ?? 0)}px square at (${Math.round(box.x)}, ${Math.round(box.y)})`,
  );
}

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(url, { waitUntil: "networkidle" });
    // A brand-new venue shows the standby card, which has no rows to overlap;
    // the check still proves the corner is there and inside the screen.
    await page.locator("main section").first().waitFor();

    await check(page, "board 1");
    const eventView = tvMode(new URL(url).searchParams.get("event") ?? undefined) === "event";
    // Where a phone that scans the hydrated code lands: the Oasis website on
    // the event view, this page's own leaderboard on the rotation.
    const target = eventView ? OASIS_WEBSITE_URL : `${new URL(page.url()).origin}${STANDINGS_PATH}`;
    const scanned = decodeQrMarkup(await page.locator("#tv-phone-qr").evaluate((el) => el.outerHTML));
    if (scanned !== target) {
      throw new Error(`corner code opens ${scanned ?? "nothing readable"}, expected ${target}`);
    }
    console.log(`corner code opens: ${scanned}`);
    const menuShown = await page.getByRole("button", { name: "Open screen menu" }).isVisible();
    if (menuShown === eventView) {
      throw new Error(`Screens button is ${menuShown ? "shown" : "hidden"} on the ${eventView ? "event view" : "rotation"}`);
    }
    console.log(`Screens button: ${menuShown ? "shown" : "hidden"}`);
    await page.screenshot({ path: out });
    console.log(`screenshot: ${out}`);
    // Later boards get the same name with their number before the extension.
    const outFor = (n: number) => out.replace(/(\.[a-z]+)?$/i, `-board${n}$1`);

    for (let n = 2; n <= boards; n++) {
      const before = await page.locator("main footer p").first().textContent();
      // "Board 1 of 1", or standby: there is no next board to wait for.
      if (!/Board \d+ of (?!1$)\d+/.test(before ?? "")) {
        console.log(`board ${n}: skipped - nothing to rotate to (${before?.trim()})`);
        break;
      }
      await page.waitForFunction(
        (was) => document.querySelector("main footer p")?.textContent !== was,
        before,
        { timeout: 40_000 },
      );
      await check(page, `board ${n}`);
      await page.screenshot({ path: outFor(n) });
      console.log(`screenshot: ${outFor(n)}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`FAIL ${(error as Error).message}`);
  process.exit(1);
});
