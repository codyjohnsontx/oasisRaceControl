import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * Unit suite: no database, no network. Runs everywhere including CI.
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
