/** Single-venue product: "tonight" always means the venue's local date.
 * Mirrors venue_today() in the database — keep the zones in sync. */
export const VENUE_TIMEZONE = "America/Chicago";

/** Venue-local date as YYYY-MM-DD (en-CA locale formats exactly that way). */
export function venueToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: VENUE_TIMEZONE,
  }).format(now);
}

/**
 * Venue-local calendar month as "August 2026". A league season is a calendar
 * month, so this is the name a new season gets by default - staff should not
 * have to invent one twelve times a year.
 */
export function venueMonthName(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: VENUE_TIMEZONE,
    month: "long",
    year: "numeric",
  }).format(now);
}
