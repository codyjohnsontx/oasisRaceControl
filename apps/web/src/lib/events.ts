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
  /**
   * The agent's own sequence number for each of those failures, the newest
   * ten. A heartbeat whose answer was lost is followed by one reporting the
   * same failures under a new `sequence`; these let the monitor count each
   * failure once (rule 6 in src/lib/monitor/rules.ts). Stored in `payload`.
   */
  signInFailureSeqs: z.array(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)).max(10).optional(),
  /** Agent notices raised since the previous heartbeat. */
  notices: z.array(z.string().max(200)).max(10).optional(),
  /** The agent's own footprint: the live version of R0's measurement. */
  agentCpuPercent: z.number().min(0).max(100_000).optional(),
  agentMemoryMb: z.number().min(0).max(1_000_000).optional(),
  /** True on the goodbye an agent sends as it exits. */
  shuttingDown: z.boolean().optional(),
  /**
   * This heartbeat's place among the ones this agent process has sent, from 1.
   * With `processStartedAt` it orders one process's heartbeats however the
   * network reordered them, so an ordinary heartbeat that lands after the
   * goodbye it was sent before cannot read as the rig coming back
   * (`rigState` in src/lib/monitor/rig-state.ts). Stored in `payload`.
   */
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
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

/**
 * Largest request body the ingestion route will read, in bytes.
 *
 * Sized from the contract, not from the platform. A full outbox batch of 100
 * laps with every string at its limit is about 75 KB, and about 260 KB in the
 * worst case where the agent's JSON writer escapes every character of every
 * name as \uXXXX (System.Text.Json escapes non-ASCII by default); a v2
 * heartbeat is a few KB. 1 MiB clears the worst legitimate body four times
 * over and still refuses an oversized one - zod strips unknown keys, so a
 * megabyte of junk beside a valid heartbeat would otherwise parse - long
 * before Vercel's own 4.5 MB ceiling.
 */
export const MAX_EVENTS_BODY_BYTES = 1024 * 1024;

export const agentEventsBody = z.object({
  // 100 is the agent's outbox flush size. At most one of them may be a
  // heartbeat: both producers send heartbeats one per request, and a batch of
  // 100 would be 100 history rows written for one request.
  events: z
    .array(agentEvent)
    .min(1)
    .max(100)
    .superRefine((events, ctx) => {
      events.forEach((event, index) => {
        if (
          event.type === "RIG_HEARTBEAT" &&
          events.findIndex((e) => e.type === "RIG_HEARTBEAT") !== index
        ) {
          ctx.addIssue({
            code: "custom",
            message: "at most one RIG_HEARTBEAT per request",
            path: [index],
          });
        }
      });
    }),
});

export type LapCompletedEvent = z.infer<typeof lapCompletedEvent>;
export type AgentEventsBody = z.infer<typeof agentEventsBody>;

/**
 * iRacing's `SessionState`, as the SDK numbers it: 0 invalid, 1 get in car,
 * 2 warmup, 3 parade laps, 4 racing, 5 checkered, 6 cool down.
 */
export const SESSION_STATE = {
  invalid: 0,
  getInCar: 1,
  warmup: 2,
  paradeLaps: 3,
  racing: 4,
  checkered: 5,
  coolDown: 6,
} as const;

/** The most cars an iRacing session holds; `CarIdx` arrays are this long. */
const MAX_CARS = 64;
/** iRacing's lap counters are 16-bit; 32767 is its "unlimited" sentinel. */
const MAX_LAPS = 32_767;
/** One week: iRacing reports an untimed session as 604800 s remaining. */
const MAX_SESSION_SECONDS = 7 * 24 * 60 * 60;

const lapCounter = z.number().int().min(0).max(MAX_LAPS);
const lapTime = z.number().int().positive().max(MAX_LAP_TIME_MS);
const carPosition = z.number().int().min(1).max(MAX_CARS);

/**
 * One rig's live race status: its own car, read from iRacing's shared memory,
 * posted alone to `POST /api/agent/race-status` - not through
 * `/api/agent/events`, because this is the opposite of a lap: ephemeral, latest
 * wins, never queued and never retried. The server keeps one row per rig
 * (`rig_race_status`, db/migrations/0008_race_status.sql) and the live feed
 * (`GET /api/race/live`) joins it to whoever is checked in on the rig. Nothing
 * here names a driver or an iRacing account: identity comes from the rig's
 * assignment, as a lap's does. docs/live-race.md describes the whole loop.
 *
 * What the agent must do with it, which is the other half of this contract:
 *
 * - Report only while iRacing is in a session (`SessionState` above 0), every
 *   2-3 s. A report identical to the last one sent may be skipped, but never
 *   for more than 10 s: the feed marks a rig `stale` after 15 s of silence and
 *   drops it after 60 s, so a parked car that stops reporting reads as a dead
 *   rig.
 * - One report in flight at a time, and none kept: a report that fails is
 *   dropped, and the next sample is sent. A stale position is worth nothing.
 *   The server keeps whichever report ARRIVED last, so a report abandoned on a
 *   timeout that lands after its successor would show for one cadence.
 * - Send null, not iRacing's sentinels, where a field is nullable: a position
 *   of 0 (not yet classified), a lap time of -1 or 0 (none yet), a negative lap
 *   counter or lap distance (not in the world), 32767 laps or 604800 s
 *   remaining (unlimited).
 * - Clamp to the bounds below before sending. The body is validated whole, so
 *   one field out of bounds refuses the report with a 400 and the car vanishes
 *   from the board.
 *
 * A 200 carries no body. A 401 is a token problem, a 400 is a contract
 * mismatch; neither is retried.
 */
export const raceStatusEvent = z.object({
  /** The rig's clock when it read the sim. Stored for diagnosis only. */
  sampledAt: instant,
  /** `SessionUniqueID`: the same on every rig in one hosted session. */
  sessionUniqueId: z.number().int().min(0).max(PG_INT_MAX),
  /**
   * `SessionNum`: which session of the weekend (practice, qualifying, race),
   * an index into a list iRacing keeps to a handful of entries.
   */
  sessionNum: z.number().int().min(0).max(63),
  /** `SessionInfo.Sessions[SessionNum].SessionType`, e.g. "Race"; null until read. */
  sessionType: z.string().min(1).max(40).nullable(),
  sessionState: z.number().int().min(SESSION_STATE.invalid).max(SESSION_STATE.coolDown),
  /** `SessionFlags`, read as the unsigned 32-bit bitfield it is. */
  sessionFlags: z.number().int().min(0).max(0xffff_ffff),
  /** `SessionTimeRemain`; null for an untimed session. */
  sessionTimeRemainS: z.number().min(0).max(MAX_SESSION_SECONDS).nullable(),
  /** `SessionLapsRemainEx`; null for a session with no lap limit. */
  sessionLapsRemain: lapCounter.nullable(),
  /** `PlayerCarIdx`. */
  carIdx: z.number().int().min(0).max(MAX_CARS - 1),
  /** `PlayerCarPosition`; null while iRacing reports 0. */
  position: carPosition.nullable(),
  /** `PlayerCarClassPosition`; null while iRacing reports 0. */
  classPosition: carPosition.nullable(),
  /** `Lap`: laps started. */
  lap: lapCounter.nullable(),
  /** `LapCompleted`. */
  lapsCompleted: lapCounter.nullable(),
  /** `LapDistPct`: how far round the current lap, 0 to 1. */
  lapDistPct: z.number().min(0).max(1).nullable(),
  /**
   * `CarIdxF2Time[PlayerCarIdx]`: seconds behind the leader in a race. Outside
   * a race iRacing puts a lap time in the same variable; send it as read, and
   * the feed only treats it as a gap when the session is a race. Bounded by a
   * day: no gap in a session the venue runs is longer.
   */
  gapToLeaderS: z.number().min(0).max(86_400).nullable(),
  /** `CarIdxLastLapTime[PlayerCarIdx]`, in ms. */
  lastLapMs: lapTime.nullable(),
  /** `CarIdxBestLapTime[PlayerCarIdx]`, in ms. */
  bestLapMs: lapTime.nullable(),
  /** `OnPitRoad`. */
  onPitRoad: z.boolean(),
  /** `PlayerCarMyIncidentCount`: this session's incidents. */
  incidents: z.number().int().min(0).max(9_999),
});

export type RaceStatusEvent = z.infer<typeof raceStatusEvent>;

/**
 * Largest race report the route reads. A report at every bound, its session
 * type escaped as \uXXXX throughout, is under 1 KB; 4 KiB refuses anything
 * else long before it is parsed.
 */
export const MAX_RACE_STATUS_BODY_BYTES = 4 * 1024;

/**
 * Whether the agent told us what it knew about attribution at capture time.
 * True for a stamped assignment id AND for the explicit null that means "nobody
 * was checked in"; false only for an agent old enough not to send the field.
 */
export function statesCaptureTimeAttribution(lap: LapCompletedEvent): boolean {
  return "rigAssignmentId" in lap;
}
