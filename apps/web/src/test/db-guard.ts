/**
 * Guard for the integration suite's database URL.
 *
 * Integration tests TRUNCATE tables between cases, so pointing them at a real
 * database would destroy data. `apps/web/.env.local` normally holds a live Neon
 * URL, so the suite deliberately ignores DATABASE_URL and reads only
 * TEST_DATABASE_URL - and even then requires a local host and a database name
 * containing "test". Anything else is a hard failure, never a warning.
 */

/** Hosts that are never acceptable, checked first so the error names the risk. */
const MANAGED_HOST = /neon\.tech|supabase\.co|amazonaws\.com|azure\.com|render\.com/i;

const LOCAL_HOST = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

export class UnsafeTestDatabaseError extends Error {}

/**
 * Returns the validated TEST_DATABASE_URL, or null when it is unset (the
 * integration suite then skips rather than failing).
 * @throws UnsafeTestDatabaseError if the URL is set but unsafe to truncate.
 */
export function safeTestDatabaseUrl(
  raw: string | undefined = process.env.TEST_DATABASE_URL,
): string | null {
  if (!raw || raw.trim() === "") return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeTestDatabaseError(
      `TEST_DATABASE_URL is not a valid URL: ${redact(raw)}`,
    );
  }

  if (MANAGED_HOST.test(url.hostname)) {
    throw new UnsafeTestDatabaseError(
      `Refusing to run destructive tests against managed host "${url.hostname}". ` +
        `TEST_DATABASE_URL must be a local throwaway database.`,
    );
  }

  if (!LOCAL_HOST.has(url.hostname)) {
    throw new UnsafeTestDatabaseError(
      `Refusing to run destructive tests against non-local host "${url.hostname}". ` +
        `TEST_DATABASE_URL must point at localhost.`,
    );
  }

  const database = url.pathname.replace(/^\//, "");
  if (!/test/i.test(database)) {
    throw new UnsafeTestDatabaseError(
      `Refusing to run destructive tests against database "${database}" - ` +
        `its name must contain "test" to prove it is disposable.`,
    );
  }

  return raw;
}

/** Strips any credentials before a URL reaches a log or an assertion message. */
function redact(raw: string): string {
  return raw.replace(/\/\/[^@/]*@/, "//***@");
}
