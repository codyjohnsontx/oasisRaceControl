import { describe, expect, it } from "vitest";
import { liveTracks, trackKey, trackLabel } from "./leaderboards";

describe("trackKey", () => {
  it("treats null config as empty", () => {
    expect(trackKey({ track_name: "Spa", track_config: null })).toBe("Spa|");
  });

  it("distinguishes layouts of the same track", () => {
    const a = trackKey({ track_name: "Nürburgring", track_config: "GP" });
    const b = trackKey({ track_name: "Nürburgring", track_config: "Endurance" });
    expect(a).not.toBe(b);
  });
});

describe("trackLabel", () => {
  it("includes the config with an em dash when present", () => {
    expect(trackLabel({ track_name: "Spa", track_config: "Grand Prix Pits" })).toBe(
      "Spa — Grand Prix Pits",
    );
  });

  it("omits the config section when null", () => {
    expect(trackLabel({ track_name: "Monza", track_config: null })).toBe("Monza");
  });
});

describe("liveTracks", () => {
  const session = (rig_id: string, track_name: string, track_config: string | null, car_name: string | null) => ({
    rig_id,
    track_name,
    track_config,
    car_name,
  });
  const monza = { track_name: "Monza", track_config: "Grand Prix", car_name: "BMW M4 GT3" };

  it("groups sessions into one track per layout, counting rigs and naming cars once", () => {
    expect(
      liveTracks(
        [
          session("r1", "Monza", "Grand Prix", "Porsche 911 GT3 R"),
          session("r1", "Monza", "Grand Prix", "BMW M4 GT3"),
          session("r2", "Monza", "Grand Prix", "BMW M4 GT3"),
          session("r3", "Spa", null, null),
        ],
        null,
      ),
    ).toEqual([
      { track_name: "Monza", track_config: "Grand Prix", car_names: ["BMW M4 GT3", "Porsche 911 GT3 R"], rig_count: 2 },
      { track_name: "Spa", track_config: null, car_names: [], rig_count: 1 },
    ]);
  });

  it("treats a null layout and an empty one as one track", () => {
    const tracks = liveTracks([session("r1", "Spa", null, "Ferrari 296 GT3"), session("r2", "Spa", "", "Ferrari 296 GT3")], null);
    expect(tracks.map((t) => t.rig_count)).toEqual([2]);
  });

  it("on a featured-combo day keeps only the rigs whose laps would rank", () => {
    const tracks = liveTracks(
      [
        session("r1", "Monza", "Grand Prix", "BMW M4 GT3"),
        session("r2", "Monza", "Grand Prix", "Porsche 911 GT3 R"),
        session("r3", "Spa", null, "BMW M4 GT3"),
        session("r4", "Monza", "Junior", "BMW M4 GT3"),
        session("r5", "Monza", "Grand Prix", null),
      ],
      monza,
    );
    expect(tracks).toEqual([{ track_name: "Monza", track_config: "Grand Prix", car_names: ["BMW M4 GT3"], rig_count: 1 }]);
  });

  it("on a featured-combo day lists nothing when no rig is in the combo", () => {
    expect(liveTracks([session("r1", "Spa", null, "BMW M4 GT3")], monza)).toEqual([]);
  });
});
