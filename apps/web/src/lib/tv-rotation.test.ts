import { describe, expect, it } from "vitest";
import { tvMode } from "./tv-rotation";

describe("tvMode", () => {
  it("is the ordinary rotation when the page has no event parameter", () => {
    expect(tvMode(undefined)).toBe("rotation");
  });

  it.each(["1", "", "true", "yes", "cota"])("opens the event view for ?event=%j", (value) => {
    expect(tvMode(value)).toBe("event");
  });

  it("reads ?event=0 as the rotation, so a link can be switched off in place", () => {
    expect(tvMode("0")).toBe("rotation");
  });

  it("takes the first value when the parameter is repeated", () => {
    expect(tvMode(["1", "0"])).toBe("event");
  });
});
