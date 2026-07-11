import { describe, expect, it } from "vitest";
import { computeValidity, type FeaturedCombo } from "./validity";

const combo: FeaturedCombo = {
  track_name: "Spa-Francorchamps",
  track_config: "Grand Prix Pits",
  car_name: "Porsche 911 GT3 R",
  incident_limit: 0,
};

const cleanLap = {
  trackName: "Spa-Francorchamps",
  trackConfig: "Grand Prix Pits",
  carName: "Porsche 911 GT3 R",
  incidentDelta: 0,
};

describe("computeValidity with a featured combo", () => {
  it("accepts a clean lap on the right combo", () => {
    expect(computeValidity(cleanLap, combo)).toEqual({
      isValid: true,
      invalidReason: null,
    });
  });

  it("rejects any incident under the 0x rule", () => {
    expect(computeValidity({ ...cleanLap, incidentDelta: 1 , }, combo)).toEqual({
      isValid: false,
      invalidReason: "INCIDENT_LIMIT_EXCEEDED",
    });
  });

  it("allows incidents up to a nonzero limit", () => {
    expect(
      computeValidity({ ...cleanLap, incidentDelta: 2 }, { ...combo, incident_limit: 2 }),
    ).toEqual({ isValid: true, invalidReason: null });
  });

  it("rejects the wrong track or config", () => {
    expect(computeValidity({ ...cleanLap, trackName: "Monza" }, combo).invalidReason).toBe(
      "WRONG_TRACK_CONFIGURATION",
    );
    expect(
      computeValidity({ ...cleanLap, trackConfig: "Endurance" }, combo).invalidReason,
    ).toBe("WRONG_TRACK_CONFIGURATION");
  });

  it("rejects the wrong car", () => {
    expect(
      computeValidity({ ...cleanLap, carName: "Ferrari 296 GT3" }, combo).invalidReason,
    ).toBe("WRONG_CAR");
  });

  it("treats missing incidentDelta as clean", () => {
    expect(computeValidity({ ...cleanLap, incidentDelta: null }, combo).isValid).toBe(true);
  });

  it("matches null config against empty-string config", () => {
    expect(
      computeValidity(
        { ...cleanLap, trackConfig: null },
        { ...combo, track_config: null },
      ).isValid,
    ).toBe(true);
  });
});

describe("computeValidity without a featured combo", () => {
  it("still enforces clean laps", () => {
    expect(computeValidity({ ...cleanLap, incidentDelta: 3 }, null).invalidReason).toBe(
      "INCIDENT_LIMIT_EXCEEDED",
    );
  });

  it("accepts any combo when clean", () => {
    expect(
      computeValidity({ ...cleanLap, trackName: "Anywhere", carName: "Anything" }, null)
        .isValid,
    ).toBe(true);
  });
});
