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
    const trackMatches =
      combo.track_name === lap.trackName &&
      (combo.track_config ?? "") === (lap.trackConfig ?? "");
    if (!trackMatches) {
      return { isValid: false, invalidReason: "WRONG_TRACK_CONFIGURATION" };
    }
    if (combo.car_name !== lap.carName) {
      return { isValid: false, invalidReason: "WRONG_CAR" };
    }
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
