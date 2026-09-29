import jsQR from "jsqr";

/**
 * Reads the corner QR code (`components/tv/phone-standings-qr.tsx`) back out
 * of its markup the way a phone camera would: rebuilds the module grid from
 * the single `<path>` it draws - one `M{x} {y}h1v1h-1z` square per dark
 * module on a viewBox `size` modules wide - rasterises it, and decodes it with
 * an independent decoder (`jsqr`) rather than the encoder that drew it, which
 * would agree with the wrong URL wired in. Shared by the component test, which
 * hands it server-rendered HTML, and `scripts/tv-corner-check.ts`, which hands
 * it the hydrated DOM of a real browser.
 *
 * Returns null when there is no code in the markup or it does not decode.
 */
export function decodeQrMarkup(html: string): string | null {
  const viewBox = html.match(/viewBox="0 0 (\d+) (\d+)"/);
  const path = html.match(/<path d="([^"]*)"/);
  if (!viewBox || !path) return null;
  const size = Number(viewBox[1]);
  const dark = new Set<string>();
  for (const m of path[1].matchAll(/M(\d+) (\d+)h1v1h-1z/g)) dark.add(`${m[1]},${m[2]}`);

  const scale = 4; // pixels per module; the decoder wants a few
  const px = size * scale;
  const rgba = new Uint8ClampedArray(px * px * 4);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const v = dark.has(`${Math.floor(x / scale)},${Math.floor(y / scale)}`) ? 0 : 255;
      const i = (y * px + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return jsQR(rgba, px, px)?.data ?? null;
}
