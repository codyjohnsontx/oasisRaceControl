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
