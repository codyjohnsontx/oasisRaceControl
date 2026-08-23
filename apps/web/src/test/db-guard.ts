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

export class MissingTestDatabaseError extends Error {}

/**
 * Whether a database-backed suite is allowed to skip on this machine.
 *
 * A developer with no Postgres running should get a green, honest `npm test`,
 * so the SQL-backed suites skip. CI is the opposite case: the whole reason it
 * stands up a Postgres service is to exercise those suites, and a suite that
 * skips there reports the same green as one that ran. That is not theoretical -
 * `npm run test:integration` with no TEST_DATABASE_URL exits 0 with "43
 * skipped", so a typo in a workflow variable, or a service container that never
 * became healthy, would leave the leaderboard's SQL rules unproven while the
 * pull request went green.
 *
 * CI therefore sets OASIS_REQUIRE_DB_TESTS=1, which turns every such skip into
 * a failure that names what was not run.
 */
export function databaseTestsAreRequired(
  raw: string | undefined = process.env.OASIS_REQUIRE_DB_TESTS,
): boolean {
  return raw === "1";
}

/**
 * The single place a database-backed suite decides whether "no database" is
 * acceptable, so the integration suite and the SQL-backed unit suite cannot
 * drift into answering it differently.
 *
 * @param url the database this suite would use, or null if it found none.
 * @param suite what will go unproven, named the way a person reading a failed
 *   CI log needs it - not the file name.
 * @param required defaults to the environment, and is passed explicitly only by
 *   this rule's own tests - which otherwise read whatever the machine running
 *   them happens to have set, and so pass locally and fail in CI.
 * @throws MissingTestDatabaseError when a database is required and absent.
 */
export function requireTestDatabase(
  url: string | null,
  suite: string,
  required: boolean = databaseTestsAreRequired(),
): void {
  if (url || !required) return;
  throw new MissingTestDatabaseError(
    `OASIS_REQUIRE_DB_TESTS=1, but no local Postgres was reachable, so ${suite} ` +
      `were never exercised. Skipping them here would report a green build for ` +
      `rules nothing checked. Set TEST_DATABASE_URL to a local throwaway ` +
      `database whose name contains "test".`,
  );
}
