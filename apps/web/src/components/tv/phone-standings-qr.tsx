"use client";

import { useSyncExternalStore } from "react";
import { encode } from "uqr";

/**
 * The QR code in the corner of `/tv` that opens the phone leaderboard.
 *
 * The wall is sometimes a laptop on a table at an off-site event, and the
 * people looking at it want the same standings on their own phones without
 * typing a hosted URL. So every board carries a small code that opens
 * `/leaderboards` on whatever origin is serving the wall - the hosted site, a
 * preview deploy, or a laptop on a venue's wifi - with nothing to configure.
 *
 * Encoding is `uqr`: MIT, no dependencies, ~80KB unpacked, pure ESM, still
 * published this year, and it hands back the module matrix rather than a
 * canvas or data URL, so the code renders as one inline `<path>` sized in `em`
 * like everything else under `.tv-scale`. The heavier `qrcode` package pulls
 * in a CLI's worth of dependencies for the same matrix.
 *
 * Two parts, split so the drawing is testable through react-dom/server:
 * `StandingsQr` is a pure function of the URL it is handed, and
 * `PhoneStandingsQr` is the one-hook wrapper that reads the origin on the
 * client (there is no `window` on the server, and the first paint must not
 * guess one).
 */

/** Path of the phone leaderboard, appended to the page's own origin. */
export const STANDINGS_PATH = "/leaderboards";

/** The URL the corner code opens, for a wall served from `origin`. */
export function standingsHref(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${STANDINGS_PATH}`;
}

/** Quiet zone in modules on each side. The QR spec asks for four; the code
 *  sits on its own light card on a dark wall, which is a clean enough edge that
 *  three keep the modules larger at the sizes a laptop shows. */
const QUIET_ZONE = 3;

/**
 * The drawing itself: a light card with the code and a short label. Pure, so
 * a test can render it to static markup and decode what it drew.
 *
 * Sized in `em` of `.tv-scale`: the square is 10em, which is 89px on the
 * venue's 1272x601 panel and 120px on a 1440x900 laptop - small in the corner,
 * still about three device pixels per module for a phone camera.
 */
export function StandingsQr({ href }: { href: string }) {
  const qr = encode(href, { border: QUIET_ZONE });
  const path = qr.data
    .flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : [])))
    .join("");

  return (
    <figure
      id="tv-phone-qr"
      className="flex shrink-0 items-center gap-[0.875em]"
      aria-label={`Full standings on your phone: ${href}`}
    >
      <figcaption className="text-ink/80 text-right text-[1em]/[1.35] font-bold uppercase tracking-[0.2em]">
        Full standings
        <br />
        on your phone
      </figcaption>
      <svg
        viewBox={`0 0 ${qr.size} ${qr.size}`}
        className="h-[10em] w-[10em] rounded-[0.5em] bg-white"
        shapeRendering="crispEdges"
        aria-hidden="true"
      >
        <path d={path} fill="#000" />
      </svg>
    </figure>
  );
}

/** The origin never changes while a page is open, so there is nothing to subscribe to. */
const subscribeToNothing = () => () => {};

/** Draws the code for the page's own origin, once there is one: the server
 *  snapshot is null, so the server paint and the hydrating paint agree. */
export function PhoneStandingsQr() {
  const origin = useSyncExternalStore(
    subscribeToNothing,
    () => window.location.origin,
    () => null,
  );
  return origin ? <StandingsQr href={standingsHref(origin)} /> : null;
}
