import { z } from "zod";

/**
 * Agent → backend event contract.
 *
 * PROVISIONAL: field details (session identity, validity signals) may change
 * when the Phase 1 iRacing spike findings land (docs/spike-findings.md). The
 * C# Rig Agent must be built against the final version of this contract.
 */

/**
 * What the rig can currently do with its simulator, as the agent sees it.
 *
 * `scoring` - iRacing is running and every channel a lap's validity turns on is
 * readable, so a lap driven now would be judged and published.
 * `unreadable` - iRacing is running but the agent cannot judge a lap from it, so
 * it is holding laps back rather than publishing times it cannot vouch for.
 * `no_sim` - nothing to read: iRacing closed, loading, or in a menu. The normal
 * state of an idle rig.
 */
export const simHealth = z.enum(["scoring", "unreadable", "no_sim"]);

export const heartbeatEvent = z.object({
  type: z.literal("RIG_HEARTBEAT"),
  agentVersion: z.string().max(40).optional(),
  /**
   * Absent means unknown, not healthy: an agent from before this field existed
   * says nothing about its simulator, and the dashboard must not read that as a
   * rig that is fine. Sent on every heartbeat because it is a live reading.
   */
  simHealth: simHealth.nullish(),
  /**
   * Why, in the agent's own words, when `simHealth` is `unreadable` - it names
   * the channels the sim is not publishing, which is the difference between
   * "why is rig 7 not scoring" taking a minute and taking a night.
   */
  simHealthDetail: z.string().max(300).nullish(),
  /**
   * Which computer this heartbeat came from - a stable opaque id the agent
   * derives from a seed in its own data directory and the machine's name.
   *
   * A rig's token is its whole identity to this backend, so installing the
   * fleet by copying one machine's folder to the next silently merges two
   * simulators into one rig and credits half the laps to the wrong customer.
   * With this, two live installations claiming one rig is something the backend
   * can see - and it holds that rig's laps rather than guessing whose they are.
   *
   * Absent means an agent too old to say. That must leave the rig's recorded
   * machine alone rather than reading as a takeover, or a fleet part-way
   * through an update would flap.
   */
  installationId: z.string().min(8).max(64).nullish(),
  /**
   * The machine's own name, carried only so the dashboard can say WHICH two
   * computers are fighting over a rig. Staff can act on "RIG-03 and RIG-07";
   * they cannot act on a hash.
   */
  machineName: z.string().min(1).max(80).nullish(),
});

export const lapCompletedEvent = z.object({
  type: z.literal("LAP_COMPLETED"),
  /** Idempotency key minted by the agent when the event is queued. */
  eventId: z.string().min(8).max(128),
  /**
   * The rig assignment the agent believed was open when the lap was driven.
   * Sent so the server binds the lap to the driver who actually drove it: a
   * lap that waited in the agent's outbox through an outage must not land on
   * whoever happens to be checked in when it finally arrives. Absent (older
   * agents, the fake-rig simulator, or a lap driven while the agent knew of no
   * check-in) means "no claim" and the server falls back to the rig's open
   * assignment, still guarded by the lap's own completion time.
   */
  rigAssignmentId: z.uuid().nullish(),
  trackName: z.string().min(1).max(120),
  trackConfig: z.string().max(120).nullish(),
  carName: z.string().min(1).max(120),
  lapNumber: z.number().int().min(0).nullish(),
  lapTimeMs: z.number().int().positive(),
  incidentDelta: z.number().int().min(0).nullish(),
  /**
   * Whether the car's own tyres left the racing surface at any point during
   * this lap, as the agent watched it (iRacing's `PlayerTrackSurface`).
   *
   * Carried separately from `incidentDelta` because the two do not always
   * agree: the venue's rule invalidates a lap for going off, but the sim only
   * charges an incident point for some offs — a wide exit that gains time is
   * routinely free. Without this the fastest lap on the board can be one that
   * never fully stayed on the track, which is the one wrong answer a
   * leaderboard cannot recover from.
   *
   * It stays the agent's raw observation rather than being folded into the
   * incident count, so `incidentDelta` remains the sim's own number and the
   * backend keeps deciding what invalidates a lap (`src/lib/validity.ts`).
   *
   * Absent means an agent too old to say, and is read as "no off-track seen" —
   * the behaviour those rigs already have. It must not be read as "unknown, so
   * invalidate", or a fleet part-way through an update would void every lap on
   * the rigs not yet reached.
   */
  offTrackSeen: z.boolean().nullish(),
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
