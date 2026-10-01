import { describe, expect, it } from "vitest";
import { newPinRefusal } from "./new-pin";

describe("newPinRefusal", () => {
  it("lets the same four digits typed twice through", () => {
    expect(newPinRefusal("0427", "0427")).toBeNull();
  });

  it("refuses a second PIN that differs from the first", () => {
    expect(newPinRefusal("0427", "0472")).toMatch(/don't match/);
    expect(newPinRefusal("0427", "")).toMatch(/don't match/);
  });

  it("refuses a PIN that is not four digits before comparing", () => {
    expect(newPinRefusal("042", "042")).toMatch(/4 digits/);
  });
});
