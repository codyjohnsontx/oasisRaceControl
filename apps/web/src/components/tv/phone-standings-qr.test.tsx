import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { decodeQrMarkup } from "@/test/decode-qr-markup";
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

const decode = decodeQrMarkup;

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
    // client knows. standingsHref below pins that target, and tv-corner-check
    // decodes the hydrated code in a real browser against the page's origin.
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
