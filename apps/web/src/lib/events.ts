import { z } from "zod";

/**
 * Agent → backend event contract.
 *
 * PROVISIONAL: field details (session identity, validity signals) may change
 * when the Phase 1 iRacing spike findings land (docs/spike-findings.md). The
 * C# Rig Agent must be built against the final version of this contract.
 */

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
   *             null: an older agent's laps are refused rather than guessed at.
   * Absence is only distinguishable from null because zod leaves an unsupplied
   * optional key off the parsed object entirely (`"rigAssignmentId" in lap`),
   * so current agents always send the key, null included.
   */
  rigAssignmentId: z.uuid().nullable().optional(),
  trackName: z.string().min(1).max(120),
  trackConfig: z.string().max(120).nullish(),
  carName: z.string().min(1).max(120),
  lapNumber: z.number().int().min(0).nullish(),
  lapTimeMs: z.number().int().positive(),
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
