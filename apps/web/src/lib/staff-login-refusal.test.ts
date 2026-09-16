import { describe, expect, it } from "vitest";
import {
  MIN_STAFF_PASSWORD_LENGTH,
  STAFF_LOGIN_REFUSALS,
  staffLoginRefusal,
} from "./staff-login-refusal";

/**
 * One test per distinct message a refused staff sign-in can show, because the
 * defect being fixed was that there was only ever one of them. The pin on
 * wrong-email against wrong-password is the load-bearing case: it is the one
 * pair that must NOT become distinct, and a future change that splits them
 * would look like an improvement to whoever wrote it.
 */

describe("staffLoginRefusal", () => {
  it("names the minimum when the password is shorter than it", () => {
    const message = staffLoginRefusal(400, "password_too_short");

    expect(message).toBe(STAFF_LOGIN_REFUSALS.password_too_short);
    // The number is the actionable part: the 2026-09-13 incident was a
    // password set by SQL under the minimum, and nothing said so.
    expect(message).toContain(String(MIN_STAFF_PASSWORD_LENGTH));
  });

  it("gives a server error its own message, blaming the site not the typing", () => {
    expect(staffLoginRefusal(500, "server_error")).toBe(STAFF_LOGIN_REFUSALS.server_error);
    expect(STAFF_LOGIN_REFUSALS.server_error).not.toBe(STAFF_LOGIN_REFUSALS.invalid_credentials);
  });

  it("keeps the rate-limit message as it was", () => {
    expect(staffLoginRefusal(429, "rate_limited")).toBe("Too many attempts — wait a minute");
  });

  it("tells the person to check the fields when the body was unreadable", () => {
    expect(staffLoginRefusal(400, "invalid_input")).toBe(STAFF_LOGIN_REFUSALS.invalid_input);
  });

  it("still says something actionable for a status nobody anticipated", () => {
    // A proxy's HTML error page: 4xx, no code to read. Silence is not an
    // acceptable outcome on a screen a person operates.
    const message = staffLoginRefusal(418, undefined);

    expect(message).toBe(STAFF_LOGIN_REFUSALS.unknown);
    expect(message).not.toBe("Sign-in failed");
  });

  it("answers on status alone when the body carried no code", () => {
    expect(staffLoginRefusal(503, undefined)).toBe(STAFF_LOGIN_REFUSALS.server_error);
    expect(staffLoginRefusal(429, undefined)).toBe(STAFF_LOGIN_REFUSALS.rate_limited);
  });

  it("has one message for a refused credential, and it names neither field as the wrong one", () => {
    // The route answers a wrong email and a wrong password with the same
    // invalid_credentials code (pinned in the route's own test), so the only
    // way wording could give an account away is this message naming which
    // field failed. Do not "improve" it into "no account with that email" -
    // that is the regression, not a nicety.
    const message = staffLoginRefusal(401, "invalid_credentials").toLowerCase();
    expect(message).toBe(STAFF_LOGIN_REFUSALS.invalid_credentials.toLowerCase());
    for (const giveaway of ["account", "no such", "not found", "unknown email", "not registered"]) {
      expect(message).not.toContain(giveaway);
    }
  });
});
