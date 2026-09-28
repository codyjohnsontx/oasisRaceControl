/**
 * The host logo slot of the `/tv` event view.
 *
 * An off-site event is held at somebody's venue, and the event board carries
 * that host's logo in the footer where the venue's own rotation would say which
 * board is up. The link names the host - `/tv?event=1&host=cadillac` - and only
 * a host on this list is drawn: the files are bundled under
 * `public/host-logos/`, so an unknown name has nothing to show and shows
 * nothing, exactly as a link with no `host` does. The plain rotation never
 * reads it.
 *
 * Each file is the host's own official artwork, unaltered - the source is
 * recorded beside the entry - and the board tints it for its dark background
 * in CSS rather than in the file (`invert`, on a single-colour black mark). A
 * host is a mark plus an optional wordmark, drawn as one lockup: the footer
 * sizes the pair together, so a wordmark is the host's own and never text the
 * board sets in its own type.
 */
export type TvHostLogo = {
  /** The host's mark: path under `public/`, and the file's own aspect ratio
   *  (the footer sets only the height). */
  mark: TvHostImage;
  /** Read for the mark; the wordmark, when there is one, says the same. */
  alt: string;
  /** The host's name in the host's own lettering, beside the mark. */
  wordmark?: TvHostImage;
};

export type TvHostImage = { src: string; width: number; height: number };

const HOST_LOGOS: Record<string, TvHostLogo> = {
  cadillac: {
    // The global-navigation crest of cadillac.com, saved as served on 2026-09-27:
    // https://www.cadillac.com/content/dam/cadillac/na/us/english/ux/share-nav-assets/cadillac-logo.svg
    mark: { src: "/host-logos/cadillac.svg", width: 82, height: 32 },
    alt: "Cadillac",
    // Cadillac's current official wordmark, the all-caps CADILLAC that its own
    // pages pair with the crest, saved as served by cadillac.com on 2026-09-27:
    // https://www.cadillac.com/content/dam/cadillac/na/us/english/index/vehicles/future-and-concept/electric-vehicles/lyriq-reserve-now/svg/25-cadillac-footer-wordmark.svg
    // The owner asked for the cursive script signature first; no official file
    // of it exists on cadillac.com, media.cadillac.com or media.gm.com, and he
    // chose this one instead (2026-09-27).
    wordmark: { src: "/host-logos/cadillac-wordmark.svg", width: 380.04962, height: 79.12886 },
  },
};

/**
 * Reads the host off the page's `host` search parameter: the logo to draw, or
 * null for no parameter, a repeated one, or a name that is not bundled.
 */
export function tvHostLogo(host: string | string[] | undefined): TvHostLogo | null {
  if (typeof host !== "string") return null;
  return Object.prototype.hasOwnProperty.call(HOST_LOGOS, host) ? HOST_LOGOS[host] : null;
}
