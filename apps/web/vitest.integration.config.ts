import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { safeTestDatabaseUrl } from "./src/test/db-guard";

/**
 * Integration suite: real Postgres, so it covers what mocks cannot - the
 * guarantees that live in SQL rather than in application code. The root
 * README's "Integration tests" section lists them; keeping a second inventory
 * here only gives it something to drift from.
 *
 * DATABASE_URL is set from the validated TEST_DATABASE_URL so the app's own pool
 * (@/lib/db) connects to the throwaway database and never to whatever
 * .env.local happens to point at. Files run serially: these cases assert on
 * whole-table state and truncate between tests.
 */
const testUrl = safeTestDatabaseUrl();

export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  test: {
    include: ["src/**/*.integration.test.ts"],
    globalSetup: ["src/test/global-setup.ts"],
    fileParallelism: false,
    env: {
      DATABASE_URL: testUrl ?? "",
      // Routes that read a driver session need this present; the session module
      // itself is mocked, but importing it must not throw on a missing secret.
      SESSION_SECRET: "integration-test-secret-not-used-for-real-sessions",
    },
  },
});
