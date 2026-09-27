/**
 * Screenshots `/tv` and proves the phone-standings QR code in the corner is
 * fully on screen and overlaps nothing: not a board row, not the board's
 * header, not the rest of the footer. Then it waits for the rotation to move
 * and checks the next board too, so the corner is proven on more than the
 * board that happened to be up.
 *
 * Runs against a live server in the system's Google Chrome through
 * `playwright-core` - no browser download, and nothing in `npm test` needs a
 * server. The viewport defaults to the venue wall's 1272x601; pass a laptop
 * size to see what the owner's screen shows.
 *
 * Usage (server already running, see README):
 *   npx tsx scripts/tv-corner-check.ts [--url http://localhost:3000/tv]
 *     [--viewport 1272x601] [--out tv-corner.png] [--boards 2]
 *
 * Exits non-zero on the first overlap or clipped corner it finds.
 */
import { chromium, type Page } from "playwright-core";

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

/** Every on-screen box the corner must keep clear of, with a name for the report. */
async function neighbours(page: Page): Promise<Array<{ name: string; box: Box }>> {
  const named: Array<{ name: string; box: Box }> = [];
  const add = async (selector: string, label: (i: number) => string) => {
    const handles = await page.locator(selector).all();
    for (const [i, h] of handles.entries()) {
      const box = await h.boundingBox();
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
    await page.screenshot({ path: out });
    console.log(`screenshot: ${out}`);

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
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`FAIL ${(error as Error).message}`);
  process.exit(1);
});
