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
    | "OFF_TRACK"
    | "WRONG_TRACK_CONFIGURATION"
    | "WRONG_CAR"
    | null;
};

/**
 * How many incidents this lap is charged with for the purpose of the limit.
 *
 * The sim's own count is the floor, not the whole story: iRacing does not
 * charge a point for every trip off the road, so a lap can be run wide at the
 * fastest corner on the track and come back with a clean 0x. The agent watches
 * the surface itself for exactly that reason, and an off it saw counts as one
 * incident when the sim charged nothing.
 *
 * It is `max`, not a sum, because when the sim DID charge for the off, adding
 * to it would charge the same mistake twice — and the two signals cannot be
 * told apart from here. Counting it against the same limit, rather than
 * invalidating outright, is what keeps the rule consistent: a venue that
 * tolerates one incident should not be stricter about an off the sim let go
 * than about one it punished.
 */
function countedIncidents(
  lap: Pick<LapCompletedEvent, "incidentDelta" | "offTrackSeen">,
): { counted: number; charged: number } {
  const charged = lap.incidentDelta ?? 0;
  return { counted: Math.max(charged, lap.offTrackSeen ? 1 : 0), charged };
}

/** Whether a lap was set on the combo the venue has featured for tonight.
 *  Exported because the staff dashboard labels tonight's laps with it live —
 *  the same comparison `v_fastest_tonight` and `v_league_round_laps` make in
 *  SQL, and the only place it is ever made. */
export function isOnCombo(
  lap: Pick<LapCompletedEvent, "trackName" | "trackConfig" | "carName">,
  combo: FeaturedCombo | null,
): boolean {
  if (!combo) return true;
  return (
    combo.track_name === lap.trackName &&
    (combo.track_config ?? "") === (lap.trackConfig ?? "") &&
    combo.car_name === lap.carName
  );
}

/**
 * Server-side lap validity, independent of whatever the agent claims.
 * Venue rule (discovery decision): clean laps only — any incident invalidates.
 *
 * `is_valid` answers one question and only one: was this lap clean. It is
 * decided once, at ingestion, and never revisited, so nothing that can be
 * corrected later belongs in it.
 *
 * Which content counts tonight is exactly that kind of thing, so it is NOT
 * decided here. Whether a lap is on the featured combo is asked at read time,
 * by `v_fastest_tonight` and `v_league_round_laps`, against whatever the combo
 * says at the moment somebody looks. Freezing it into the lap as well cost the
 * venue twice:
 *
 * - Staff type tonight's league combo by hand, and the sim's own names are what
 *   the rigs report. One character apart — "Dallara IR18" for "Dallara IR-18" —
 *   and every lap the room drives is stored WRONG_CAR. Correcting the round
 *   afterwards fixes both views instantly, but a frozen verdict keeps the whole
 *   night off the board for good.
 * - A walk-in's clean lap at Monza while a league round runs on Spa is not a
 *   dirty lap. Storing it invalid erased it from Monza's permanent arcade board
 *   as well, which is a scheduling choice deleting a customer's time.
 *
 * The combo still decides which incident limit applies, because a raised limit
 * is one of that combo's rules: a lap set on other content is judged by the
 * venue's own clean-laps-only default instead.
 */
export function computeValidity(
  lap: Pick<
    LapCompletedEvent,
    "trackName" | "trackConfig" | "carName" | "incidentDelta" | "offTrackSeen"
  >,
  combo: FeaturedCombo | null,
): ValidityResult {
  const limit = combo && isOnCombo(lap, combo) ? combo.incident_limit : 0;
  return withinIncidentLimit(lap, limit);
}

/**
 * The reason names what the driver would have to do differently, so a lap put
 * out by an off the sim did not charge reads "off track" and not "incident" —
 * the driver's 0x is right there on their own screen, and telling them they
 * exceeded an incident limit they can see they did not is how staff end up
 * arguing with a leaderboard.
 */
function withinIncidentLimit(
  lap: Pick<LapCompletedEvent, "incidentDelta" | "offTrackSeen">,
  limit: number,
): ValidityResult {
  const { counted, charged } = countedIncidents(lap);
  if (counted <= limit) return { isValid: true, invalidReason: null };
  return {
    isValid: false,
    invalidReason: charged > limit ? "INCIDENT_LIMIT_EXCEEDED" : "OFF_TRACK",
  };
}
