import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * Default suite: pure logic plus the route handlers' auth and validation
 * branches. Runs everywhere including CI without a database.
 *
 * One exception, deliberate and documented in the root README:
 * src/lib/league-round-lifecycle.test.ts matches the include glob below and,
 * when TEST_DATABASE_URL or a local DATABASE_URL is present, builds its own
 * throwaway database (create/drop, never truncating an existing one) to cover
 * rules that live in SQL. It skips when neither is set, and when DATABASE_URL is
 * not local, so `npm test` stays safe and green on a machine pointed at Neon. An
 * explicit but unsafe TEST_DATABASE_URL is a hard error instead, since it was an
 * instruction.
 *
 * `scripts/` is in the include glob for one file: the migration bookkeeping
 * behind `npm run db:check`, the deploy gate that refuses to build against a
 * database that is behind db/migrations. It is pure and needs no database.
 *
 * `*.test.tsx` covers components that render to static markup through
 * react-dom/server - no DOM shim is installed, so a component test here can
 * only assert on the HTML string, which is enough for a component with no
 * state and is the reason those components are kept hook-free.
 *
 * The `@/` alias mirrors tsconfig paths so API route modules (which import
 * `@/lib/...`) can be imported directly by tests. Integration tests live in
 * *.integration.test.{ts,tsx} and are excluded here - the exclude covers both
 * extensions the include does, so no integration file can be picked up by this
 * suite - see vitest.integration.config.ts.
 */
export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    exclude: ["src/**/*.integration.test.{ts,tsx}", "node_modules/**"],
  },
});
