import { describe, expect, it } from "vitest";
import { TV_BOARD_TYPES, buildRotation } from "./board-types";

/**
 * The two rotation lists. The event view is one slide - the tonight board
 * asked for everyone - and the venue's rotation is exactly what it was before
 * the event view existed, so the wall in the shop cannot have changed under a
 * laptop feature.
 */

const boards = [
  { track_name: "Circuit of the Americas", track_config: "Grand Prix", driver_count: 24, lap_count: 47 },
  { track_name: "Spa-Francorchamps", track_config: null, driver_count: 3, lap_count: 9 },
];

describe("buildRotation", () => {
  it("event view is the tonight board with everyone on it, and nothing else", () => {
    const slides = buildRotation(boards, "event");
    expect(slides).toEqual([{ key: "event", kind: "tonight", spec: { everyone: true } }]);
  });

  it("the venue rotation is league, tonight (top slots), then every track, in order", () => {
    const slides = buildRotation(boards);
    expect(slides.map((s) => s.key)).toEqual([
      "league",
      "tonight",
      "track:Circuit of the Americas|Grand Prix",
      "track:Spa-Francorchamps|",
    ]);
    expect(slides[1].spec).toEqual({ everyone: false });
    expect(buildRotation(boards, "rotation")).toEqual(slides);
  });

  it("every slide names a registered board type", () => {
    for (const mode of ["rotation", "event"] as const) {
      for (const slide of buildRotation(boards, mode)) {
        expect(TV_BOARD_TYPES[slide.kind]?.kind).toBe(slide.kind);
      }
    }
  });
});
