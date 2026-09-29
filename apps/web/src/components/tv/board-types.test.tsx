import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TV_BOARD_TYPES, buildRotation } from "./board-types";
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
 * had; a lap with any gets an asterisk after its time, and nothing else on the
 * board explains it - the owner wanted the mark alone, no legend.
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

/**
 * What the tonight board asks the feed for. The event view promises every
 * driver of the day, so it asks for all of them - it once asked for a
 * 200-row ceiling and the 201st driver vanished while the board still read
 * "200 drivers". The rotation's slide makes the request it always has.
 */
describe("tonight board feed request", () => {
  afterEach(() => vi.unstubAllGlobals());

  const requestedUrl = async (everyone: boolean) => {
    const fetch = vi.fn(async () => Response.json({ rows: [row(1, 0)], combo }));
    vi.stubGlobal("fetch", fetch);
    await tonight.load({ everyone }, new AbortController().signal);
    return (fetch.mock.calls[0] as unknown[])[0];
  };

  it("the event view asks for every driver of the day", async () => {
    expect(await requestedUrl(true)).toBe("/api/leaderboard/tonight?limit=all");
  });

  it("the rotation's slide asks with no limit, as it always has", async () => {
    expect(await requestedUrl(false)).toBe("/api/leaderboard/tonight");
  });
});

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

  it("marks on the wall's ten slots too, and draws no legend for it", () => {
    // An incident lap below the rotation's cut is not on screen there; in the
    // event view, which shows everyone, it is.
    const rows = Array.from({ length: SLOT_COUNT + 1 }, (_, i) => row(i + 1, i === SLOT_COUNT ? 3 : 0));
    const slots = renderToStaticMarkup(
      <tonight.Board spec={{ everyone: false }} data={{ rows, combo }} stale={false} hold={() => {}} />,
    );
    expect(asterisksIn(slots)).toBe(0);
    const everyone = renderToStaticMarkup(
      <tonight.Board spec={{ everyone: true }} data={{ rows, combo }} stale={false} hold={() => {}} />,
    );
    expect(asterisksIn(everyone)).toBe(1);
    // No visible legend for the mark, on either layout.
    expect(everyone).not.toContain("* lap");
    expect(slots).not.toContain("* lap");
  });
});
