import { z } from "zod";

/**
 * Agent → backend event contract.
 *
 * PROVISIONAL: field details (session identity, validity signals) may change
 * when the Phase 1 iRacing spike findings land (docs/spike-findings.md). The
 * C# Rig Agent must be built against the final version of this contract.
 */

/**
 * Upper bound on `lapTimeMs`: thirty minutes.
 *
 * Chosen from what a lap can be, not from what the wall can print. The longest
 * layout iRacing offers is the Nürburgring combined 24h circuit at roughly
 * 25 km, and the slowest cars in the catalogue take around twelve minutes to
 * get round it flat out; a car limping home on three wheels after a crash still
 * makes it inside thirty. No track or configuration the venue runs produces a
 * genuine lap longer than that, so a value past this is not a slow lap, it is a
 * lap that did not happen - a session timer or the wrong unit read as a lap
 * time - and the batch is rejected as invalid input like any other malformed
 * field. Nothing else bounds it: `laps.lap_time_ms` is an `int` with only a
 * `> 0` check, so without this a two-hour "lap" is stored valid and ranks.
 *
 * It happens to keep `formatLapTime` inside the nine characters the /tv time
 * columns are fitted for (`59:59.999`, see arcade-board.tsx), but that is a
 * consequence of the ceiling, not its reason - a ceiling picked to fit a column
 * would move the next time the column did.
 */
export const MAX_LAP_TIME_MS = 30 * 60_000;

export const heartbeatEvent = z.object({
  type: z.literal("RIG_HEARTBEAT"),
  agentVersion: z.string().max(40).optional(),
});

export const lapCompletedEvent = z.object({
  type: z.literal("LAP_COMPLETED"),
  /** Idempotency key minted by the agent when the event is queued. */
  eventId: z.string().min(8).max(128),
  /**
   * The assignment the agent had for this rig **when it captured the lap** -
   * the only honest answer to "who drove this". A queued lap can reach the
   * backend minutes later, by which time someone else may be checked in, so the
   * server must never re-derive the owner from whatever is open on arrival.
   *
   * Three states, and the difference between them matters:
   *   uuid    - a driver was checked in; attribute the lap to that assignment.
   *   null    - the agent knew nobody was checked in; the lap has no owner.
   *   absent  - the agent predates this field and cannot say. Not the same as
   *             null: an older agent's laps are stored unattributed rather than
   *             guessed at, so they are kept but can never rank.
   * Absence is only distinguishable from null because zod leaves an unsupplied
   * optional key off the parsed object entirely (`"rigAssignmentId" in lap`),
   * so current agents always send the key, null included.
   */
  rigAssignmentId: z.uuid().nullable().optional(),
  trackName: z.string().min(1).max(120),
  trackConfig: z.string().max(120).nullish(),
  carName: z.string().min(1).max(120),
  lapNumber: z.number().int().min(0).nullish(),
  lapTimeMs: z.number().int().positive().max(MAX_LAP_TIME_MS),
  incidentDelta: z.number().int().min(0).nullish(),
  completedAt: z.iso.datetime({ offset: true }),
});

export const agentEvent = z.discriminatedUnion("type", [
  heartbeatEvent,
  lapCompletedEvent,
]);

export const agentEventsBody = z.object({
  events: z.array(agentEvent).min(1).max(100),
});

export type LapCompletedEvent = z.infer<typeof lapCompletedEvent>;
export type AgentEventsBody = z.infer<typeof agentEventsBody>;

/**
 * Whether the agent told us what it knew about attribution at capture time.
 * True for a stamped assignment id AND for the explicit null that means "nobody
 * was checked in"; false only for an agent old enough not to send the field.
 */
export function statesCaptureTimeAttribution(lap: LapCompletedEvent): boolean {
  return "rigAssignmentId" in lap;
}
