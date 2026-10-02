import { describe, expect, it } from "vitest";
import { isOpenTonight } from "./league";
import { venueToday } from "./venue";

/**
 * Tonight's league night: the one rule behind the wall's takeover and whether
 * a race is shown or polled for at all, on the wall and on `/league`.
 */
describe("isOpenTonight", () => {
  const yesterday = venueToday(new Date(Date.now() - 86_400_000));

  it("is a round still open on the venue's current day", () => {
    expect(isOpenTonight({ closed_at: null, round_date: venueToday() })).toBe(true);
  });

  it("is not a round staff have closed, nor one left open from an earlier day", () => {
    expect(isOpenTonight({ closed_at: "2026-10-02T03:00:00Z", round_date: venueToday() })).toBe(false);
    expect(isOpenTonight({ closed_at: null, round_date: yesterday })).toBe(false);
  });
});
