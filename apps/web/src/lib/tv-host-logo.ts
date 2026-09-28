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
 * in CSS rather than in the file (`invert`, on a single-colour black mark).
 */
export type TvHostLogo = {
  /** Path under `public/`. */
  src: string;
  alt: string;
  /** The file's own aspect ratio; the footer sets only the height. */
  width: number;
  height: number;
};

const HOST_LOGOS: Record<string, TvHostLogo> = {
  // The global-navigation crest of cadillac.com, saved as served on 2026-09-27:
  // https://www.cadillac.com/content/dam/cadillac/na/us/english/ux/share-nav-assets/cadillac-logo.svg
  cadillac: { src: "/host-logos/cadillac.svg", alt: "Cadillac", width: 82, height: 32 },
};

/**
 * Reads the host off the page's `host` search parameter: the logo to draw, or
 * null for no parameter, a repeated one, or a name that is not bundled.
 */
export function tvHostLogo(host: string | string[] | undefined): TvHostLogo | null {
  if (typeof host !== "string") return null;
  return Object.prototype.hasOwnProperty.call(HOST_LOGOS, host) ? HOST_LOGOS[host] : null;
}
