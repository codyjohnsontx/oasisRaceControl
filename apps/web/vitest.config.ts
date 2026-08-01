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
 * The `@/` alias mirrors tsconfig paths so API route modules (which import
 * `@/lib/...`) can be imported directly by tests. Integration tests live in
 * *.integration.test.ts and are excluded here - see vitest.integration.config.ts.
 */
export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.integration.test.ts", "node_modules/**"],
  },
});
