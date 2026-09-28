import { describe, expect, it } from "vitest";
import { dragScrollTop, dragsToScroll } from "./drag-scroll";

describe("dragsToScroll", () => {
  it("drags for the primary button of a mouse or a pen", () => {
    expect(dragsToScroll("mouse", 0)).toBe(true);
    expect(dragsToScroll("pen", 0)).toBe(true);
  });

  it("leaves a finger to the browser's own panning", () => {
    expect(dragsToScroll("touch", 0)).toBe(false);
  });

  it("ignores any other button", () => {
    expect(dragsToScroll("mouse", 1)).toBe(false);
    expect(dragsToScroll("mouse", 2)).toBe(false);
  });
});

describe("dragScrollTop", () => {
  it("scrolls down the list as the pointer moves up", () => {
    expect(dragScrollTop(100, 400, 250)).toBe(250);
  });

  it("scrolls back up the list as the pointer moves down", () => {
    expect(dragScrollTop(300, 250, 400)).toBe(150);
  });

  it("leaves the list where it is when the pointer has not moved", () => {
    expect(dragScrollTop(120, 300, 300)).toBe(120);
  });

  it("stops at the top of the list", () => {
    expect(dragScrollTop(40, 100, 300)).toBe(0);
  });
});
