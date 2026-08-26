import type { NextConfig } from "next";

/**
 * Standalone output is what the container image ships: `.next/standalone`
 * carries a self-contained `server.js` plus only the traced `node_modules`, so
 * the runtime stage needs no `npm ci` and no dev dependencies
 * (`apps/web/Dockerfile`).
 *
 * It is opt-in rather than always-on because turning it on changes two paths
 * that have nothing to do with containers:
 *
 * - `next start` prints `"next start" does not work with "output: standalone"`
 *   (Next 16.2.10 still serves, but it is unsupported and may stop). AGENTS.md
 *   documents `npm run build && npm run start` as the only way to verify /tv's
 *   failure behaviour, because dev-mode HMR force-reloads the page instead.
 * - Vercel builds its own output format. It is not this repo's job to find out
 *   whether it also honours this flag; the venue's deploy path stays exactly
 *   what it has always been.
 *
 * So only `docker build` sets it, and everything else is byte-for-byte
 * unchanged.
 */
const nextConfig: NextConfig = {
  output: process.env.NEXT_OUTPUT_STANDALONE === "1" ? "standalone" : undefined,
};

export default nextConfig;
