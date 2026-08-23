import { describe, expect, it } from "vitest";
import { comboText, describeComboMismatch, type TonightCombo } from "./combo-mismatch";
import type { FeaturedCombo } from "./validity";

const COMBO: FeaturedCombo = {
  track_name: "Watkins Glen International",
  track_config: "Boot",
  car_name: "Dallara IR-18",
  incident_limit: 0,
};

/** What the rigs report: iRacing's own display names, which is where the
 *  disagreement always comes from. */
function driven(
  car: string,
  counts: { laps: number; rigs: number },
  track = "Watkins Glen International",
  config: string | null = "Boot",
): TonightCombo {
  return {
    track_name: track,
    track_config: config,
    car_name: car,
    lap_count: counts.laps,
    rig_count: counts.rigs,
  };
}

describe("a league night set on a combo the rigs do not recognise", () => {
  it("names what the room is actually running when nobody is scoring", () => {
    // Staff typed "Dallara IR-18"; the sim calls it "Dallara IR18".
    const mismatch = describeComboMismatch([driven("Dallara IR18", { laps: 41, rigs: 12 })], COMBO);
    expect(mismatch).toEqual({
      running: driven("Dallara IR18", { laps: 41, rigs: 12 }),
      offComboLaps: 41,
      rigs: 12,
    });
  });

  it("stays quiet while one customer is on the wrong car", () => {
    // Twelve rigs are scoring. The thirteenth loaded a Mazda, which is that
    // customer's business and not a fault.
    expect(
      describeComboMismatch(
        [driven("Dallara IR-18", { laps: 40, rigs: 12 }), driven("Mazda MX-5", { laps: 3, rigs: 1 })],
        COMBO,
      ),
    ).toBeNull();
  });

  it("stays quiet while most of the room is scoring and a group is not", () => {
    // Three friends loading the same wrong car together is the case that breaks
    // a rule written as "more than one rig disagrees". Twelve rigs ARE on the
    // round, so the round is right - and repointing it at those three would
    // void the twelve who are scoring, which is worse than the fault.
    expect(
      describeComboMismatch(
        [
          driven("Dallara IR-18", { laps: 40, rigs: 12 }),
          driven("Mazda MX-5", { laps: 9, rigs: 3 }),
        ],
        COMBO,
      ),
    ).toBeNull();
  });

  it("stays quiet when a single rig is off on its own", () => {
    // One machine cannot tell a mistyped combo from a customer's own choice, and
    // guessing wrong tells staff to repoint the whole night at one person's car.
    expect(
      describeComboMismatch([driven("Mazda MX-5", { laps: 6, rigs: 1 })], COMBO),
    ).toBeNull();
  });

  it("says nothing before anyone has finished a lap", () => {
    expect(describeComboMismatch([], COMBO)).toBeNull();
  });

  it("says nothing on a night with no featured combo", () => {
    expect(describeComboMismatch([driven("Mazda MX-5", { laps: 30, rigs: 9 })], null)).toBeNull();
  });

  it("catches the track being the typo, not just the car", () => {
    const mismatch = describeComboMismatch(
      [driven("Dallara IR-18", { laps: 22, rigs: 8 }, "Watkins Glen Intl")],
      COMBO,
    );
    expect(mismatch?.running.track_name).toBe("Watkins Glen Intl");
  });

  it("catches a layout typed in on a track that has none", () => {
    // The sim reports null for a single-layout track. Typing a layout name into
    // the round form is enough to void the night on its own.
    const mismatch = describeComboMismatch(
      [driven("Mazda MX-5", { laps: 15, rigs: 5 }, "Lime Rock Park", null)],
      { ...COMBO, track_name: "Lime Rock Park", track_config: "Classic", car_name: "Mazda MX-5" },
    );
    expect(mismatch?.running.track_config).toBeNull();
  });

  it("points at the content most of the room is on, not the loudest one rig", () => {
    // A busy machine racking up short laps must not outweigh the eleven rigs
    // that agree with each other about what the round is.
    const mismatch = describeComboMismatch(
      [
        driven("Mazda MX-5", { laps: 80, rigs: 1 }),
        driven("Dallara IR18", { laps: 30, rigs: 11 }),
      ],
      COMBO,
    );
    expect(mismatch?.running.car_name).toBe("Dallara IR18");
    // ...and the count staff read is the whole night held back, not one combo's.
    expect(mismatch?.offComboLaps).toBe(110);
  });
});

describe("comboText", () => {
  it("reads as the venue says it", () => {
    expect(comboText(COMBO)).toBe("Watkins Glen International (Boot) · Dallara IR-18");
  });

  it("leaves out a layout the track does not have", () => {
    expect(comboText({ ...COMBO, track_config: null })).toBe(
      "Watkins Glen International · Dallara IR-18",
    );
  });
});
