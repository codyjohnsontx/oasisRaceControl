import { SESSION_STATE } from "@/lib/events";
import type { LiveRace, LiveRaceRow } from "@/lib/race-live";

/** One car in a live race, as the feed returns it, with the fields a test cares about overridden. */
export function liveRaceRow(
  rigNumber: number,
  place: number,
  extra: Partial<LiveRaceRow> = {},
): LiveRaceRow {
  return {
    rigNumber,
    driverId: `d${rigNumber}`,
    driverName: `Driver ${rigNumber}`,
    carIdx: rigNumber,
    place,
    position: place,
    classPosition: place,
    lap: 5,
    lapsCompleted: 4,
    lapDistPct: 0.5,
    gapToLeaderS: place === 1 ? 0 : place * 1.5,
    intervalS: place === 1 ? null : 1.5,
    lastLapMs: 95_000 + place * 100,
    bestLapMs: 94_000,
    onPitRoad: false,
    incidents: 0,
    ageS: 1,
    stale: false,
    ...extra,
  };
}

/** A race under green with `rows` in it, as `GET /api/race/live` returns one. */
export function liveRaceFeed(
  rows: LiveRaceRow[],
  session: Partial<NonNullable<LiveRace["session"]>> = {},
): LiveRace {
  return {
    session: {
      sessionUniqueId: 100,
      sessionNum: 2,
      sessionType: "Race",
      isRace: true,
      byTrack: true,
      sessionState: SESSION_STATE.racing,
      sessionFlags: 4,
      timeRemainS: 600,
      lapsRemain: null,
      ...session,
    },
    rows,
    otherRigs: 0,
  };
}
