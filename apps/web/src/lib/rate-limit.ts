import { queryOne } from "./db";

/**
 * Minimal in-memory sliding-window rate limiter for unauthenticated routes.
 * Best-effort by design: on serverless it's per-instance, which still stops
 * naive scripted abuse. A shared store (Postgres counter / Upstash) is the
 * production-hardening upgrade if it proves insufficient.
 */

const buckets = new Map<string, number[]>();
const MAX_TRACKED_KEYS = 10_000;

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  if (buckets.size > MAX_TRACKED_KEYS) evict(now, windowMs);

  const hits = (buckets.get(key) ?? []).filter((t) => t > now - windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}

/** Drop keys with no hits inside the window first (their limiters are inert);
 * only if everything is somehow active, drop oldest-inserted keys. Never
 * clears the whole map — that would reset active limiters mid-attack. */
function evict(now: number, windowMs: number): void {
  for (const [key, hits] of buckets) {
    const newest = hits[hits.length - 1];
    if (newest === undefined || newest <= now - windowMs) buckets.delete(key);
  }
  for (const key of buckets.keys()) {
    if (buckets.size <= MAX_TRACKED_KEYS / 2) break;
    buckets.delete(key);
  }
}

export function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"
  );
}

/** Test seam only: forget every bucket. */
export function resetRateLimits(): void {
  buckets.clear();
}

const WINDOW_MS = 60_000;

/**
 * How many new drivers one rig may produce in a minute.
 *
 * A rig is one seat, so the honest ceiling is one person signing up at a time,
 * with room for the retries a real sign-up takes: a taken name and its
 * suggestion, a mistyped PIN, a phone that lost the venue's wifi mid-tap.
 */
const PER_RIG_LIMIT = 8;

/**
 * The same allowance for somebody who is not standing at a rig - `/me` on a
 * phone, or a QR code that has been re-issued since it was printed. There is no
 * seat to key on, so this is the old per-address bucket and it keeps the old
 * ceiling.
 */
const PER_ADDRESS_LIMIT = 10;

/**
 * Whether a request may create a driver row (a guest, or a new profile).
 *
 * The venue is behind one public address. Twenty-two rigs, every customer on
 * the guest wifi, and the carriers' own NAT for the ones who are not: on a
 * league night the address a request arrives from names the building, not a
 * person, so throttling per address throttles *the venue* - the eleventh
 * customer through the door is refused while the ten before them drive.
 *
 * So when the request comes from a rig's own check-in page we key on the rig
 * instead. That is the one bound the room genuinely has: a seat holds one
 * person, so a seat producing drivers faster than a person can sign up is
 * abuse, and twenty-two seats between them can never reach a total the venue
 * would notice. A code the fleet does not recognise is not a seat, so it falls
 * back to the address bucket and cannot be used to mint an unbounded number of
 * fresh buckets.
 *
 * @param qrToken The rig code the check-in page was opened with, when there was one.
 */
export async function allowNewDriver(
  request: Request,
  qrToken?: string | null,
): Promise<boolean> {
  const rigId = qrToken ? await rigIdForQrToken(qrToken) : null;
  return rigId
    ? rateLimit(`new-driver:rig:${rigId}`, PER_RIG_LIMIT, WINDOW_MS)
    : rateLimit(`new-driver:ip:${clientIp(request)}`, PER_ADDRESS_LIMIT, WINDOW_MS);
}

/** The rig a printed code belongs to, or null when the fleet does not know it. */
async function rigIdForQrToken(qrToken: string): Promise<string | null> {
  const row = await queryOne<{ rig_id: string }>(
    "select rig_id from rig_qr_tokens where token = $1 and active",
    [qrToken],
  );
  return row?.rig_id ?? null;
}
