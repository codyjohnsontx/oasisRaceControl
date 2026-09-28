import { describe, expect, it } from "vitest";
import { tvHostLogo } from "./tv-host-logo";

describe("tvHostLogo", () => {
  it("names a bundled host's official files and their own aspect ratios", () => {
    expect(tvHostLogo("cadillac")).toEqual({
      mark: { src: "/host-logos/cadillac.svg", width: 82, height: 32 },
      alt: "Cadillac",
      wordmark: { src: "/host-logos/cadillac-wordmark.svg", width: 380.04962, height: 79.12886 },
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
