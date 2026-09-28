import { describe, expect, it } from "vitest";
import { tvMode } from "./tv-rotation";

describe("tvMode", () => {
  it("is the ordinary rotation when the page has no event parameter", () => {
    expect(tvMode(undefined)).toBe("rotation");
  });

  it("opens the event view for ?event=1", () => {
    expect(tvMode("1")).toBe("event");
  });

  it("plays the rotation for ?event=false", () => {
    expect(tvMode("false")).toBe("rotation");
  });

  it.each(["", "0", "true", "yes", "cota"])("plays the rotation for ?event=%j", (value) => {
    expect(tvMode(value)).toBe("rotation");
  });

  it("takes the first value when the parameter is repeated", () => {
    expect(tvMode(["1", "0"])).toBe("event");
    expect(tvMode(["0", "1"])).toBe("rotation");
  });
});
