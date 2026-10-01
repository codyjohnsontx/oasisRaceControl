import type { LapCompletedEvent } from "./events";

export type FeaturedCombo = {
  track_name: string;
  track_config: string | null;
  car_name: string;
  incident_limit: number;
};

export type ValidityResult = {
  isValid: boolean;
  invalidReason:
    | "INCIDENT_LIMIT_EXCEEDED"
    | "WRONG_TRACK_CONFIGURATION"
    | "WRONG_CAR"
    | null;
};

/**
 * Server-side lap validity, independent of whatever the agent claims.
 * Venue rule (discovery decision): clean laps only — any incident invalidates.
 * When a featured combo is set for tonight, laps on the wrong content are
 * stored but marked invalid so they never rank.
 */
export function computeValidity(
  lap: Pick<
    LapCompletedEvent,
    "trackName" | "trackConfig" | "carName" | "incidentDelta"
  >,
  combo: FeaturedCombo | null,
): ValidityResult {
  if (combo) {
    const mismatch = comboMismatch(combo, lap);
    if (mismatch) return { isValid: false, invalidReason: mismatch };
    if ((lap.incidentDelta ?? 0) > combo.incident_limit) {
      return { isValid: false, invalidReason: "INCIDENT_LIMIT_EXCEEDED" };
    }
    return { isValid: true, invalidReason: null };
  }

  // No featured combo tonight: clean-laps-only still applies.
  if ((lap.incidentDelta ?? 0) > 0) {
    return { isValid: false, invalidReason: "INCIDENT_LIMIT_EXCEEDED" };
  }
  return { isValid: true, invalidReason: null };
}

/**
 * Whether a track and car are the featured combo's, and if not which part is
 * wrong. The one definition of "the right combo": ingestion judges every lap
 * with it, and the rig monitor (rule 7) judges a rig's live session with it,
 * so the monitor can never call a session right whose laps will be refused.
 * A missing config and an empty one are the same layout.
 */
export function comboMismatch(
  combo: Pick<FeaturedCombo, "track_name" | "track_config" | "car_name">,
  lap: { trackName: string; trackConfig?: string | null; carName: string },
): "WRONG_TRACK_CONFIGURATION" | "WRONG_CAR" | null {
  const trackMatches =
    combo.track_name === lap.trackName &&
    (combo.track_config ?? "") === (lap.trackConfig ?? "");
  if (!trackMatches) return "WRONG_TRACK_CONFIGURATION";
  if (combo.car_name !== lap.carName) return "WRONG_CAR";
  return null;
}
