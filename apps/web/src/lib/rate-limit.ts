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
  if (buckets.size > MAX_TRACKED_KEYS) buckets.clear();

  const hits = (buckets.get(key) ?? []).filter((t) => t > now - windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}

export function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"
  );
}
