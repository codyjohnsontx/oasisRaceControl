import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OFF_TRACK_FOOTNOTE, TV_BOARD_TYPES, buildRotation } from "./board-types";
import { SLOT_COUNT } from "./arcade-board";

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

/**
 * The off-track mark. The tonight feed says how many incidents each shown lap
 * had; a lap with any gets an asterisk after its time, and the footer legend
 * explaining it appears only while a marked lap is actually on the screen.
 */
const tonight = TV_BOARD_TYPES.tonight;
const combo = { track_name: "Spa-Francorchamps", track_config: "Grand Prix Pits", car_name: "Porsche 911 GT3 R" };
const row = (n: number, incident_delta: number | null) => ({
  driver_id: `d${n}`,
  display_name: `Driver ${n}`,
  lap_time_ms: 130_000 + n * 500,
  car_name: combo.car_name,
  incident_delta,
});
const asterisksIn = (html: string) => (html.match(/data-tv-asterisk/g) ?? []).length;

describe("tonight board off-track mark", () => {
  it("marks the lap with an incident, not a clean lap or one with no count", () => {
    const data = { rows: [row(1, 0), row(2, 2), row(3, null)], combo };
    const html = renderToStaticMarkup(
      <tonight.Board spec={{ everyone: true }} data={data} stale={false} hold={() => {}} />,
    );
    expect(asterisksIn(html)).toBe(1);
    const mark = html.indexOf("data-tv-asterisk");
    expect(mark).toBeGreaterThan(html.indexOf("Driver 2"));
    expect(mark).toBeLessThan(html.indexOf("Driver 3"));
  });

  it("shows the legend only when a marked lap is on screen", () => {
    expect(tonight.footnote).toBeDefined();
    const footnote = tonight.footnote!;
    const clean = { rows: [row(1, 0), row(2, null)], combo };
    expect(footnote({ everyone: true }, clean)).toBeNull();
    expect(footnote({ everyone: false }, clean)).toBeNull();

    const marked = { rows: [row(1, 0), row(2, 1)], combo };
    expect(footnote({ everyone: true }, marked)).toBe(OFF_TRACK_FOOTNOTE);
    expect(footnote({ everyone: false }, marked)).toBe(OFF_TRACK_FOOTNOTE);

    // The rotation draws ten slots: an incident lap below the cut is not on
    // screen there, but the event view shows everyone, so it is there.
    const rows = Array.from({ length: SLOT_COUNT + 1 }, (_, i) => row(i + 1, i === SLOT_COUNT ? 3 : 0));
    expect(footnote({ everyone: false }, { rows, combo })).toBeNull();
    expect(footnote({ everyone: true }, { rows, combo })).toBe(OFF_TRACK_FOOTNOTE);
  });
});
