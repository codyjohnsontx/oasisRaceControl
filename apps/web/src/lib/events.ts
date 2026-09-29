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

/** The largest value a Postgres `int` column holds. A count past it is not a
 *  count, and letting it through would 500 the whole batch on insert. */
const PG_INT_MAX = 2_147_483_647;

const count = z.number().int().min(0).max(PG_INT_MAX);
const instant = z.iso.datetime({ offset: true });
/** Payload-only, so a fraction costs nothing and is not worth a refusal. */
const seconds = z.number().min(0);
const sessionName = z.string().max(120);

/** Why a walk-up sign-in on the rig failed (DriverCheckInClient). */
export const SIGN_IN_FAILURE_KINDS = [
  "wrong_pin_or_name",
  "locked",
  "rate_limited",
  "unreachable",
  "other",
] as const;

/**
 * A rig's heartbeat, stored one row per heartbeat in `rig_heartbeats`
 * (db/migrations/0005_rig_heartbeats.sql) for the rig monitor to judge.
 *
 * v1 is `{ type, agentVersion? }` and is what every agent before
 * rig-agent/0.4-monitor sends; it must keep working, so every v2 field is
 * optional and a heartbeat carrying none of them stores a row with an empty
 * payload. v2 is what the agent can see without doing any new work - it is
 * assembled from the status the console already shows, because R0 (iRacing
 * keeps its frames) rules out the agent doing more than that.
 *
 * The bounds are part of the contract, not tidiness: the body is validated
 * whole, so a heartbeat over any of them is refused with a 400 and the rig
 * reads as silent. The agent clamps to them before sending - notices to ten of
 * 200 characters, missing variables to ten names - rather than finding out
 * here. `driverDisplayName` is deliberately absent: `assignmentId` already
 * identifies the driver, and a heartbeat must carry nothing that later needs
 * redacting.
 */
export const heartbeatEvent = z.object({
  type: z.literal("RIG_HEARTBEAT"),
  agentVersion: z.string().max(40).optional(),
  /** The rig's clock when it sent this; the server derives clock skew from it. */
  sentAt: instant.optional(),
  processStartedAt: instant.optional(),
  /** Agent starts in the last 24 hours, from the outbox's start log. */
  startCount: count.optional(),
  /** Seconds since Windows booted - a reboot and a crash loop read differently. */
  osUptimeS: seconds.optional(),
  telemetryMode: z.enum(["iracing", "simulated", "none"]).optional(),
  simConnected: z.boolean().optional(),
  telemetryFaulted: z.boolean().optional(),
  /** Telemetry variables this iRacing build did not publish. */
  missingVariables: z.array(z.string().max(64)).max(10).optional(),
  /** The session iRacing is in, in the strings laps are posted with; null when idle. */
  session: z
    .object({
      trackName: sessionName,
      trackConfig: sessionName.nullish(),
      carName: sessionName,
    })
    .nullable()
    .optional(),
  /** The assignment laps are being stamped with right now; null for nobody. */
  assignmentId: z.uuid().nullable().optional(),
  /** False until the agent's first assignment poll has succeeded. */
  assignmentKnown: z.boolean().optional(),
  pendingLaps: count.optional(),
  oldestPendingAgeS: seconds.nullable().optional(),
  rejectedLaps: count.optional(),
  checkout: z.enum(["none", "queued", "not_queued"]).optional(),
  lastLapCapturedAt: instant.nullable().optional(),
  lastLapPostedAt: instant.nullable().optional(),
  /** Walk-up sign-in failures since the previous heartbeat, and their kinds. */
  signInFailures: count.optional(),
  signInFailureKinds: z.array(z.enum(SIGN_IN_FAILURE_KINDS)).max(10).optional(),
  /** Agent notices raised since the previous heartbeat. */
  notices: z.array(z.string().max(200)).max(10).optional(),
  /** The agent's own footprint: the live version of R0's measurement. */
  agentCpuPercent: z.number().min(0).max(100_000).optional(),
  agentMemoryMb: z.number().min(0).max(1_000_000).optional(),
  /** True on the goodbye an agent sends as it exits. */
  shuttingDown: z.boolean().optional(),
});

export type HeartbeatEvent = z.infer<typeof heartbeatEvent>;

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
