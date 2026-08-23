import { isOnCombo, type FeaturedCombo } from "./validity";

/** One track/config/car the venue has actually driven tonight, with how much of
 *  the room drove it. Produced by the staff page's own aggregate over `laps`. */
export type TonightCombo = {
  track_name: string;
  track_config: string | null;
  car_name: string;
  lap_count: number;
  rig_count: number;
};

export type ComboMismatch = {
  /** What the rigs are running - the busiest combo nobody's laps are counting on. */
  running: TonightCombo;
  /** Laps tonight on content the venue is not featuring, across every combo. */
  offComboLaps: number;
  /** Rigs that have driven the busiest off-combo content. */
  rigs: number;
};

/**
 * Whether tonight's featured combo is wrong rather than the room being wrong.
 *
 * Staff type a league round's track and car by hand; the rigs report iRacing's
 * own display names. One character apart - "Dallara IR18" for "Dallara IR-18" -
 * and the two never match, so no lap driven all night reaches Fastest Tonight,
 * the league round's field, or the wall. Every rig is green, every lap is
 * stored, every lap is clean, and the boards are empty. There is nothing to
 * search for, because nothing failed.
 *
 * The signal that separates a typo from a customer on the wrong car is the
 * whole room: one rig off the combo is a person who loaded the wrong content,
 * and several rigs on the SAME other content while not one lap is on the
 * featured one is the combo being wrong. So this reports only when:
 *
 * - a combo is featured at all (nothing to disagree with otherwise),
 * - not one of tonight's laps is on it, and
 * - the busiest other content has been driven at more than one rig.
 *
 * The last rule is what keeps it quiet rather than accusing: a single rig can
 * never trigger it, and a night where nobody has finished a lap yet says
 * nothing at all.
 */
export function describeComboMismatch(
  tonight: readonly TonightCombo[],
  combo: FeaturedCombo | null,
): ComboMismatch | null {
  if (!combo) return null;

  const off = tonight.filter(
    (row) =>
      !isOnCombo(
        {
          trackName: row.track_name,
          trackConfig: row.track_config,
          carName: row.car_name,
        },
        combo,
      ),
  );
  // Somebody is scoring, so the combo is right and the rest are customers on
  // their own content - which is ordinary and needs no banner.
  if (off.length !== tonight.length || off.length === 0) return null;

  const running = [...off].sort(
    (a, b) => b.rig_count - a.rig_count || b.lap_count - a.lap_count,
  )[0]!;
  if (running.rig_count < 2) return null;

  return {
    running,
    offComboLaps: off.reduce((total, row) => total + row.lap_count, 0),
    rigs: running.rig_count,
  };
}

/** "Spa-Francorchamps (Grand Prix) · Porsche 911 GT3 R" - the one place a combo
 *  is turned into the sentence staff read, so the banner and the round header
 *  cannot describe the same combo two ways. */
export function comboText(combo: {
  track_name: string;
  track_config: string | null;
  car_name: string;
}): string {
  const config = combo.track_config ? ` (${combo.track_config})` : "";
  return `${combo.track_name}${config} · ${combo.car_name}`;
}
