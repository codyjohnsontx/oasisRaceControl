"use client";

import { useSyncExternalStore } from "react";
import { encode } from "uqr";
import type { TvMode } from "@/lib/tv-rotation";

/**
 * The QR code in the corner of `/tv`. On the shop's rotation it opens the
 * phone leaderboard; on the event view it opens the Oasis website instead.
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
 * The event view is the exception because its visitors are the public, not
 * the shop's regulars: the leaderboard page carries the site menu, and that
 * menu reaches every other screen including the staff login. The owner asked
 * for the event code to open the Oasis website instead (after the 2026-09-27
 * off-site event); the shop's wall keeps the leaderboard.
 *
 * Two parts, split so the drawing is testable through react-dom/server:
 * `CornerQr` is a pure function of the URL it is handed, and `TvCornerQr` is
 * the one-hook wrapper that picks the target for the view, reading the origin
 * on the client for the leaderboard (there is no `window` on the server, and
 * the first paint must not guess one).
 */

/** The Oasis Sim Racing website, which the event view's code opens. */
export const OASIS_WEBSITE_URL = "https://oasissimracing.com/";

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
 * The drawing itself: a light card with the code and nothing else - the owner
 * asked for no caption, because a full bottom row of times already leaves the
 * footer crowded, and a QR code in a corner explains itself. Pure, so a test
 * can render it to static markup and decode what it drew.
 *
 * Sized in `em` of `.tv-scale`: the square is 10em, which is 89px on the
 * venue's 1272x601 panel and 120px on a 1440x900 laptop - small in the corner,
 * still about three device pixels per module for a phone camera.
 */
export function CornerQr({ href, label }: { href: string; label: string }) {
  const qr = encode(href, { border: QUIET_ZONE });
  const path = qr.data
    .flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : [])))
    .join("");

  return (
    <figure id="tv-phone-qr" className="shrink-0" aria-label={`${label}: ${href}`}>
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

/** Draws the code for the view: the Oasis website on the event view, and the
 *  leaderboard on the page's own origin otherwise, once there is one - the
 *  server snapshot is null, so the server paint and the hydrating paint agree. */
export function TvCornerQr({ mode }: { mode: TvMode }) {
  const origin = useSyncExternalStore(
    subscribeToNothing,
    () => window.location.origin,
    () => null,
  );
  if (mode === "event") return <CornerQr href={OASIS_WEBSITE_URL} label="Oasis Sim Racing" />;
  return origin ? <CornerQr href={standingsHref(origin)} label="Full standings on your phone" /> : null;
}
