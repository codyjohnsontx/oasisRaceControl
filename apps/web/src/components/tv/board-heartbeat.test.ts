import { describe, expect, it, vi } from "vitest";
import { reloadIfRestored } from "./board-heartbeat";

/**
 * The owner's rule for a /tv page shown again from the back-forward cache: it
 * reloads, as a new board, and never resumes reporting as the board that said
 * goodbye. An ordinary page show (the first load) leaves the page alone.
 */
describe("reloadIfRestored", () => {
  it("reloads a page restored from the back-forward cache", () => {
    const reload = vi.fn();
    expect(reloadIfRestored({ persisted: true }, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("leaves a freshly loaded page alone", () => {
    const reload = vi.fn();
    expect(reloadIfRestored({ persisted: false }, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
