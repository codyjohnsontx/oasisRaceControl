/**
 * Screenshots `/leaderboards` at phone size - the page the `/tv` corner code
 * opens - and proves a spectator can read it: every driver name is shown in
 * full (wrapped if need be, never cut to an ellipsis), and nothing, the
 * floating Screens button included, sits on top of the LEADERBOARDS heading,
 * and the page does not scroll sideways.
 *
 * The rows are the script's own, served in place of `/api/leaderboards/board`,
 * so the names are long ones whoever has driven. The page still needs one
 * board to render the list at all, so the server needs at least one lap.
 *
 * Runs against a live server in the system's Google Chrome through
 * `playwright-core`, like `tv-corner-check.ts`.
 *
 * Usage (server already running, see README):
 *   npx tsx scripts/leaderboards-phone-check.ts
 *     [--url http://localhost:3000/leaderboards] [--viewport 390x844]
 *     [--out leaderboards-390x844.png]
 *
 * Exits non-zero on the first truncated name or covered heading it finds.
 */
import { chromium } from "playwright-core";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const url = arg("url", "http://localhost:3000/leaderboards");
const [width, height] = arg("viewport", "390x844").split("x").map(Number);
const out = arg("out", `leaderboards-${width}x${height}.png`);

/** Long names on purpose: two long words, one 24-letter word (the sign-up
 *  maximum) that can only fit by breaking, and a hyphenated one. */
const NAMES = [
  "Maximilian Verstappenberg",
  "Wolfeschlegelsteinhausen",
  "Alessandra Castellanos",
  "Jean-Baptiste Delacroix",
  "Al",
];
const ROWS = NAMES.map((display_name, i) => ({
  driver_id: `00000000-0000-4000-8000-00000000000${i}`,
  display_name,
  lap_time_ms: 92_345 + i * 1_234,
  car_name: "FIA F4",
  completed_at: "2026-09-27T18:00:00.000Z",
}));

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height }, isMobile: true, hasTouch: true });
    await page.route("**/api/leaderboards/board?**", (route) => route.fulfill({ json: { rows: ROWS } }));
    await page.goto(url, { waitUntil: "networkidle" });

    const problems: string[] = [];
    for (const name of NAMES) {
      const el = page.locator("main").getByText(name, { exact: true });
      await el.waitFor({ timeout: 15_000 });
      // Cut-off text is wider than its own box, whether or not it shows an
      // ellipsis. Measured on the text itself, not scrollWidth, which rounds.
      const clipped = await el.evaluate((p) => {
        const range = document.createRange();
        range.selectNodeContents(p);
        return range.getBoundingClientRect().width > p.getBoundingClientRect().width + 1;
      });
      if (clipped) problems.push(`name "${name}" is truncated`);
      const box = await el.boundingBox();
      if (!box || box.x < 0 || box.x + box.width > width) problems.push(`name "${name}" runs off screen`);
    }

    // A page wider than the phone zooms out or scrolls sideways; either way
    // the far column is not where a spectator is looking.
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    if (pageWidth > width) problems.push(`the page is ${pageWidth}px wide, wider than the screen`);

    const heading = page.getByRole("heading", { name: "LEADERBOARDS" });
    const cover = await heading.evaluate((h) => {
      const r = h.getBoundingClientRect();
      if (r.left < 0 || r.right > window.innerWidth) return "the viewport edge";
      // Whatever is on top anywhere across the heading must be the heading.
      for (let x = 0.02; x < 1; x += 0.08) {
        for (const y of [0.2, 0.5, 0.8]) {
          const hit = document.elementFromPoint(r.left + r.width * x, r.top + r.height * y);
          if (hit && !h.contains(hit)) {
            return `${hit.tagName.toLowerCase()} "${hit.textContent?.trim().slice(0, 30)}"`;
          }
        }
      }
      return null;
    });
    if (cover) problems.push(`the LEADERBOARDS heading is covered by ${cover}`);

    await page.screenshot({ path: out, fullPage: true });
    console.log(`screenshot: ${out}`);
    if (problems.length > 0) throw new Error(problems.join("; "));
    console.log(`ok - ${NAMES.length} names shown in full, heading clear at ${width}x${height}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`FAIL ${(error as Error).message}`);
  process.exit(1);
});
