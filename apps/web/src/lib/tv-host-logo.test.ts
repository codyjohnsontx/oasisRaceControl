import { describe, expect, it } from "vitest";
import { tvHostLogo } from "./tv-host-logo";

describe("tvHostLogo", () => {
  it("names a bundled host's official file and its own aspect ratio", () => {
    expect(tvHostLogo("cadillac")).toEqual({
      src: "/host-logos/cadillac.svg",
      alt: "Cadillac",
      width: 82,
      height: 32,
    });
  });

  it("shows nothing for no host, a repeated host, or one that is not bundled", () => {
    expect(tvHostLogo(undefined)).toBeNull();
    expect(tvHostLogo("")).toBeNull();
    expect(tvHostLogo(["cadillac", "cadillac"])).toBeNull();
    expect(tvHostLogo("Cadillac")).toBeNull();
    expect(tvHostLogo("ferrari")).toBeNull();
    // Nothing off Object.prototype is a host.
    expect(tvHostLogo("constructor")).toBeNull();
    expect(tvHostLogo("__proto__")).toBeNull();
  });
});
