/** Single-venue product: "tonight" always means the venue's local date.
 * Mirrors venue_today() in the database — keep the zones in sync. */
export const VENUE_TIMEZONE = "America/Chicago";

/** Venue-local date as YYYY-MM-DD (en-CA locale formats exactly that way). */
export function venueToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: VENUE_TIMEZONE,
  }).format(now);
}
