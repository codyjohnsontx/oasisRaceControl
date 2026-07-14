import { describe, expect, it } from "vitest";
import { trackKey, trackLabel } from "./leaderboards";

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
