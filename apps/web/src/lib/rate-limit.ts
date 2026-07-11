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
