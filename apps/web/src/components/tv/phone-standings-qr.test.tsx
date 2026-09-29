import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import jsQR from "jsqr";
import { CornerQr, OASIS_WEBSITE_URL, TvCornerQr, standingsHref } from "./phone-standings-qr";

/**
 * The corner code has one job: a phone that scans it must land where the view
 * sends it - the leaderboard of the site serving the wall, or on the event
 * view the Oasis website. So the test does what the phone
 * does - it reads the modules back out of the markup the component actually
 * rendered, rasterises them, and decodes them with an independent decoder
 * (`jsqr`) - rather than comparing against the encoder's own output, which
 * would pass with the wrong URL wired in.
 */

/** Pixels per module when rasterising; the decoder wants a few per module. */
const SCALE = 4;

/**
 * Rebuilds the module grid from the single `<path>` the component draws: one
 * `M{x} {y}h1v1h-1z` square per dark module, on a viewBox `size` modules wide.
 */
function modulesOf(html: string): { size: number; dark: Set<string> } {
  const viewBox = html.match(/viewBox="0 0 (\d+) (\d+)"/);
  const path = html.match(/<path d="([^"]*)"/);
  if (!viewBox || !path) throw new Error("no QR path in markup");
  const size = Number(viewBox[1]);
  const dark = new Set<string>();
  for (const m of path[1].matchAll(/M(\d+) (\d+)h1v1h-1z/g)) dark.add(`${m[1]},${m[2]}`);
  return { size, dark };
}

/** Decodes the QR in `html` the way a camera would, or null if it cannot. */
function decode(html: string): string | null {
  const { size, dark } = modulesOf(html);
  const px = size * SCALE;
  const rgba = new Uint8ClampedArray(px * px * 4);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const v = dark.has(`${Math.floor(x / SCALE)},${Math.floor(y / SCALE)}`) ? 0 : 255;
      const i = (y * px + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return jsQR(rgba, px, px)?.data ?? null;
}

describe("CornerQr", () => {
  it("encodes exactly the URL it is given", () => {
    const href = "https://oasis-race-control.vercel.app/leaderboards";
    const html = renderToStaticMarkup(<CornerQr href={href} label="Full standings on your phone" />);
    expect(decode(html)).toBe(href);
  });

  it("encodes a laptop's own origin just the same", () => {
    const href = "http://192.168.4.20:3000/leaderboards";
    expect(decode(renderToStaticMarkup(<CornerQr href={href} label="Full standings on your phone" />))).toBe(href);
  });

  it("draws no caption, but names its target for assistive tech", () => {
    const html = renderToStaticMarkup(<CornerQr href="https://example.test/leaderboards" label="Full standings on your phone" />);
    // The owner asked for the code alone: a caption crowds a full footer.
    expect(html).not.toContain("<figcaption");
    expect(html).toContain('aria-label="Full standings on your phone: https://example.test/leaderboards"');
  });
});

describe("TvCornerQr", () => {
  it("opens the Oasis website on the event view, never a page of this app", () => {
    // The leaderboard's site menu reaches the staff login; the event's public
    // gets the shop's website instead. Drawn on the server paint too, since it
    // needs no origin.
    const html = renderToStaticMarkup(<TvCornerQr mode="event" />);
    expect(decode(html)).toBe("https://oasissimracing.com/");
    expect(OASIS_WEBSITE_URL).toBe("https://oasissimracing.com/");
    expect(html).toContain('aria-label="Oasis Sim Racing: https://oasissimracing.com/"');
  });

  it("waits for the page's origin on the rotation, drawing nothing on the server", () => {
    // The rotation's target is this site's own leaderboard, which only the
    // client knows. standingsHref below pins that target; tv-corner-check only
    // proves a code paints in a real browser without covering a row.
    expect(renderToStaticMarkup(<TvCornerQr mode="rotation" />)).toBe("");
  });
});

describe("standingsHref", () => {
  it("appends the leaderboard path to the page's origin", () => {
    expect(standingsHref("https://oasis-race-control.vercel.app")).toBe(
      "https://oasis-race-control.vercel.app/leaderboards",
    );
    expect(standingsHref("http://localhost:3000/")).toBe("http://localhost:3000/leaderboards");
  });
});
