import { describe, expect, it } from "vitest";
import { driverAuthRefusal } from "./driver-auth-refusal";

describe("driverAuthRefusal", () => {
  it("points a taken name on New profile at Sign in, not only at another name", () => {
    const message = driverAuthRefusal("register", "name_taken");
    expect(message).toMatch(/already registered/);
    expect(message).toMatch(/use Sign in/);
    expect(message).toMatch(/pick a different name/);
  });

  it("keeps the guest tab's suggested name", () => {
    expect(driverAuthRefusal("guest", "name_taken", "Mike 2")).toContain("Mike 2");
    expect(driverAuthRefusal("guest", "name_taken")).toMatch(/pick another/);
  });

  it("points a wrong PIN at staff and a new driver at New profile", () => {
    const message = driverAuthRefusal("login", "invalid_credentials");
    expect(message).toMatch(/ask staff to reset your PIN/);
    expect(message).toMatch(/New profile/);
  });

  it("says a locked name is locked", () => {
    expect(driverAuthRefusal("login", "locked")).toMatch(/Too many wrong PINs/);
  });

  it("falls back to a retry for anything else", () => {
    expect(driverAuthRefusal("login", "server_error")).toMatch(/try again/);
  });
});
