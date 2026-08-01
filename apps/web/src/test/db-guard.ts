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

/**
 * WHATWG URL keeps an IPv6 literal bracketed - `new URL("postgres://[::1]/x").hostname`
 * is `"[::1]"`, not `"::1"` - so the brackets come off before any comparison.
 * It also normalises the literal itself, so `[0:0:0:0:0:0:0:1]` arrives as `::1`
 * and `[::ffff:127.0.0.1]` as `::ffff:7f00:1`, which is still not local and is
 * still refused.
 */
function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * Query parameters that change where pg actually connects, overriding the URL's
 * own hostname. `postgres://localhost/x_test?host=prod.neon.tech` looks local to
 * `new URL()` but pg connects to prod, so checking only the hostname is not
 * enough. Verified against pg-connection-string: `host` replaces the host and
 * `hostaddr` replaces the resolved address.
 */
const ROUTING_PARAMS = new Set(["host", "hostaddr", "port", "dbname", "service"]);

/**
 * Parameters allowed to appear at all. An allowlist rather than a blocklist so a
 * connection-string feature this code does not know about cannot reopen the
 * hole above.
 */
const ALLOWED_PARAMS = new Set(["sslmode", "application_name", "connect_timeout"]);

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

  // Checked before the hostname: a routing override makes the hostname a lie.
  for (const name of url.searchParams.keys()) {
    const lower = name.toLowerCase();
    if (ROUTING_PARAMS.has(lower)) {
      throw new UnsafeTestDatabaseError(
        `TEST_DATABASE_URL must not set the "${lower}" parameter: it overrides ` +
          `where pg connects, so the URL's own hostname would no longer be the ` +
          `real target.`,
      );
    }
    if (!ALLOWED_PARAMS.has(lower)) {
      throw new UnsafeTestDatabaseError(
        `TEST_DATABASE_URL has an unrecognised parameter "${lower}". Only ` +
          `${[...ALLOWED_PARAMS].join(", ")} are allowed, so an unknown ` +
          `connection option cannot redirect these destructive tests.`,
      );
    }
  }

  const host = bareHost(url.hostname);

  if (MANAGED_HOST.test(host)) {
    throw new UnsafeTestDatabaseError(
      `Refusing to run destructive tests against managed host "${host}". ` +
        `TEST_DATABASE_URL must be a local throwaway database.`,
    );
  }

  if (!LOCAL_HOST.has(host)) {
    throw new UnsafeTestDatabaseError(
      `Refusing to run destructive tests against non-local host "${host}". ` +
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
