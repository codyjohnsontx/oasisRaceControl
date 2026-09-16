/**
 * Why a staff sign-in was refused, in the words the operator reads.
 *
 * Every refusal on /staff/login is rendered from here, and the reason is the
 * 2026-09-13 incident: new staff passwords had been set by SQL, one was under
 * the minimum, and the form answered "Sign-in failed" whatever had gone wrong.
 * The password was correct and the account existed, so the message ruled
 * nothing out and several rounds went into finding the cause.
 *
 * The security boundary in here matters more than the wording. A wrong email
 * and a wrong password must stay ONE branch: the form gives nothing away about
 * which addresses have accounts, and splitting them into "no account with that
 * email" is a regression, not a nicety. Password length is safe to name because
 * it is judged before any lookup and describes only what was typed.
 */

/** Minimum a staff password may be. The login route enforces it; nothing
 * enforces it when a password is SET, because Oasis has no way to create a
 * staff account or reset its password except by SQL - which is exactly how the
 * incident above happened, and why the message below names the rule. */
export const MIN_STAFF_PASSWORD_LENGTH = 8;

export const STAFF_LOGIN_REFUSALS = {
  /** About the address as typed, never about whether an account uses it. */
  invalid_email: "That isn't a valid email address. Check it for typos and try again.",
  password_too_short: `Password must be at least ${MIN_STAFF_PASSWORD_LENGTH} characters. If the one you were given is shorter, it has to be set again before it will work here.`,
  /** Wrong email and wrong password both land here, deliberately. */
  invalid_credentials: "Email or password didn't match. Check both and try again.",
  server_error: "Something went wrong on the site, not with what you typed. Try again in a moment.",
  /** Pre-existing wording, kept as it was. */
  rate_limited: "Too many attempts — wait a minute",
  invalid_input: "Check the email address and password, then try again.",
  /** A status nobody anticipated still has to say something a person can act on. */
  unknown: "Sign-in failed. Try again, and tell whoever runs the site if it keeps happening.",
} as const;

/**
 * Picks the refusal for a non-OK response from POST /api/staff/login.
 *
 * Takes the status as well as the body's error code because a refusal can come
 * from something that is not the route at all - a proxy's HTML error page has
 * no code to read, and it still must not fall through to a bare failure.
 */
export function staffLoginRefusal(status: number, error?: unknown): string {
  if (status === 429) return STAFF_LOGIN_REFUSALS.rate_limited;
  if (error === "invalid_email") return STAFF_LOGIN_REFUSALS.invalid_email;
  if (error === "password_too_short") return STAFF_LOGIN_REFUSALS.password_too_short;
  if (error === "invalid_credentials") return STAFF_LOGIN_REFUSALS.invalid_credentials;
  if (status >= 500) return STAFF_LOGIN_REFUSALS.server_error;
  if (error === "invalid_input") return STAFF_LOGIN_REFUSALS.invalid_input;
  return STAFF_LOGIN_REFUSALS.unknown;
}
