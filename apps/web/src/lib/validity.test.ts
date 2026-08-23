import { describe, expect, it } from "vitest";
import { computeValidity, isOnCombo, type FeaturedCombo } from "./validity";

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

  it("leaves a clean lap on other content valid, because it was a clean lap", () => {
    // Whether it counts tonight is v_fastest_tonight's question and it asks it
    // live. Freezing the answer into the lap is what made a mistyped combo
    // unrecoverable, and it deleted a walk-in's Monza time from Monza's own
    // permanent board for the crime of being driven on a league night.
    for (const other of [
      { trackName: "Monza" },
      { trackConfig: "Endurance" },
      { carName: "Ferrari 296 GT3" },
    ]) {
      expect(computeValidity({ ...cleanLap, ...other }, combo)).toEqual({
        isValid: true,
        invalidReason: null,
      });
    }
  });

  it("judges a lap on other content by the venue's own clean-laps-only rule", () => {
    // A raised limit belongs to the combo it was raised for. A beginner night at
    // 2x must not quietly hand 2x to every other lap driven in the building.
    const forgiving = { ...combo, incident_limit: 2 };
    expect(computeValidity({ ...cleanLap, incidentDelta: 1 }, forgiving).isValid).toBe(true);
    expect(
      computeValidity({ ...cleanLap, trackName: "Monza", incidentDelta: 1 }, forgiving),
    ).toEqual({ isValid: false, invalidReason: "INCIDENT_LIMIT_EXCEEDED" });
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

describe("computeValidity and an off-track the sim did not charge for", () => {
  /**
   * The failure this closes: iRacing charges nothing for a great many trips off
   * the road, so a lap run wide at the fastest corner comes back 0x and — before
   * the agent started reporting the surface — went straight to the top of a board
   * whose whole rule is clean laps only.
   */
  it("rejects a 0x lap the agent watched go off the road", () => {
    expect(
      computeValidity({ ...cleanLap, incidentDelta: 0, offTrackSeen: true }, combo),
    ).toEqual({ isValid: false, invalidReason: "OFF_TRACK" });
  });

  it("rejects it with no featured combo set either", () => {
    expect(
      computeValidity({ ...cleanLap, incidentDelta: 0, offTrackSeen: true }, null),
    ).toEqual({ isValid: false, invalidReason: "OFF_TRACK" });
  });

  it("says off track, not incident limit, so the reason matches the driver's own screen", () => {
    // The driver can see 0x on their own display. Telling them they exceeded an
    // incident limit is how staff end up arguing with the leaderboard.
    expect(
      computeValidity({ ...cleanLap, incidentDelta: 0, offTrackSeen: true }, combo)
        .invalidReason,
    ).toBe("OFF_TRACK");
  });

  it("blames the incident when the sim charged for the off as well", () => {
    expect(
      computeValidity({ ...cleanLap, incidentDelta: 1, offTrackSeen: true }, combo)
        .invalidReason,
    ).toBe("INCIDENT_LIMIT_EXCEEDED");
  });

  it("counts an uncharged off as one incident, not as an outright void", () => {
    // A venue that tolerates one incident must not be STRICTER about an off the
    // sim let go than about one it punished — that would be a rule nobody could
    // explain at the desk.
    expect(
      computeValidity(
        { ...cleanLap, incidentDelta: 0, offTrackSeen: true },
        { ...combo, incident_limit: 1 },
      ),
    ).toEqual({ isValid: true, invalidReason: null });
  });

  it("does not charge the same off twice", () => {
    // max, not sum: one off that the sim charged for is 1 against the limit, so a
    // limit of 1 still accepts it.
    expect(
      computeValidity(
        { ...cleanLap, incidentDelta: 1, offTrackSeen: true },
        { ...combo, incident_limit: 1 },
      ),
    ).toEqual({ isValid: true, invalidReason: null });
  });

  it("still voids a lap that went off the road on other content", () => {
    // The off is a fact about the lap, so it survives the lap being on content
    // the venue is not featuring - otherwise a dirty lap would reach that
    // track's permanent board the moment a league round is open.
    for (const other of [{ trackName: "Monza" }, { carName: "Ferrari 296 GT3" }]) {
      expect(
        computeValidity({ ...cleanLap, ...other, offTrackSeen: true }, combo),
      ).toEqual({ isValid: false, invalidReason: "OFF_TRACK" });
    }
  });

  it("reads an agent too old to report the surface as no off-track", () => {
    // Rigs are updated one at a time. Reading absent as "unknown, so void" would
    // wipe out every lap on the machines the update has not reached yet.
    for (const offTrackSeen of [undefined, null] as const) {
      expect(
        computeValidity({ ...cleanLap, incidentDelta: 0, offTrackSeen }, combo),
      ).toEqual({ isValid: true, invalidReason: null });
    }
  });

  it("keeps a clean lap that stayed on the road valid", () => {
    expect(
      computeValidity({ ...cleanLap, incidentDelta: 0, offTrackSeen: false }, combo),
    ).toEqual({ isValid: true, invalidReason: null });
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

describe("isOnCombo", () => {
  it("answers no combo set as on-combo, so nothing filters a night nobody featured", () => {
    expect(isOnCombo({ trackName: "Anywhere", trackConfig: null, carName: "Anything" }, null))
      .toBe(true);
  });

  it("matches the same three fields v_fastest_tonight matches", () => {
    expect(isOnCombo(cleanLap, combo)).toBe(true);
    expect(isOnCombo({ ...cleanLap, trackName: "Monza" }, combo)).toBe(false);
    expect(isOnCombo({ ...cleanLap, trackConfig: "Endurance" }, combo)).toBe(false);
    expect(isOnCombo({ ...cleanLap, carName: "Ferrari 296 GT3" }, combo)).toBe(false);
  });

  it("reads a missing config and an empty one as the same thing", () => {
    // The agent sends null for a single-layout track; a staff form that was
    // tabbed through sends "". They are the same track.
    expect(
      isOnCombo({ ...cleanLap, trackConfig: null }, { ...combo, track_config: "" }),
    ).toBe(true);
    expect(
      isOnCombo({ ...cleanLap, trackConfig: "" }, { ...combo, track_config: null }),
    ).toBe(true);
  });

  it("is one character strict, which is the whole reason staff need to be told", () => {
    // "Dallara IR18" for "Dallara IR-18" is the realistic typo, and it is not a
    // near miss to a string comparison.
    expect(isOnCombo({ ...cleanLap, carName: "Porsche 911 GT3R" }, combo)).toBe(false);
  });
});
