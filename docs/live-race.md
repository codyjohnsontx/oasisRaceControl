# The live race feed

League night ends in a race: every rig in one hosted iRacing session. The race
board shows the running order as it changes, within a few seconds of a pass on
track. This document covers the server half: what a rig reports, what the
server keeps, and what the public feed returns. The board that draws it is a
separate change.

```
rig agent ── POST /api/agent/race-status (every 2-3 s, its own car) ──▶ rig_race_status
                                                                        (one row per rig)
board / phone ◀── GET /api/race/live (rows heard in the last 60 s, one race, in order)
```

Each rig reports only **its own car**. The server joins that row to whoever is
checked in on the rig, the same assignment that owns the rig's laps, so the
board needs no mapping from iRacing accounts to people. The cost is that a car
driven from a PC without the agent does not appear. That is acceptable for a
league race, where every car is a venue rig.

## What a rig reports

The contract is `raceStatusEvent` in
[`apps/web/src/lib/events.ts`](../apps/web/src/lib/events.ts). That file is the
single source: its bounds, its null rules and the doc comment on it are the
contract, and this page only summarises them. The agent and
`apps/web/scripts/fake-rig.ts` are its producers. Change all three together.

| Field | iRacing source | Null when |
|---|---|---|
| `sampledAt` | the rig's clock at the read | never |
| `sessionUniqueId`, `sessionNum` | `SessionUniqueID`, `SessionNum` | never |
| `sessionType` | `SessionInfo.Sessions[SessionNum].SessionType` | not yet read |
| `sessionState`, `sessionFlags` | `SessionState` (0-6), `SessionFlags` (unsigned 32-bit) | never |
| `sessionTimeRemainS`, `sessionLapsRemain` | `SessionTimeRemain`, `SessionLapsRemainEx` | the session is unlimited (iRacing's 604800 s / 32767 laps) |
| `carIdx` | `PlayerCarIdx` | never |
| `position`, `classPosition` | `PlayerCarPosition`, `PlayerCarClassPosition` | iRacing reports 0 (not classified yet) |
| `lap`, `lapsCompleted`, `lapDistPct` | `Lap`, `LapCompleted`, `LapDistPct` | negative (not in the world) |
| `gapToLeaderS` | `CarIdxF2Time[PlayerCarIdx]` | not available |
| `lastLapMs`, `bestLapMs` | `CarIdxLastLapTime` / `CarIdxBestLapTime` `[PlayerCarIdx]`, in ms | iRacing reports 0 or -1 (no lap yet) |
| `onPitRoad` | `OnPitRoad` | never |
| `incidents` | `PlayerCarMyIncidentCount` | never |

How the agent sends it:

- **Only while iRacing is in a session**, every 2-3 s. It may skip a report
  identical to the last one, but never for more than 10 s. The feed marks a rig
  stale after 15 s and drops it after 60 s, so a parked car that goes quiet
  looks like a dead rig.
- **One report in flight, nothing kept.** A report that fails is dropped and
  the next sample goes out. There is no outbox and no retry, because an old
  position is worth nothing. This is why it has its own route and does not go
  through `/api/agent/events`.
- **Clamp before sending.** The body is validated whole, so one field out of
  bounds gets the report a 400 and the car disappears from the board.
- `POST /api/agent/race-status` with the rig's bearer token and the JSON object
  as the body (no `events` wrapper). The answer is **200 with an empty body**.
  A 400 carries zod's `detail` for the rig's log. 401 means the token is wrong.
  413 means the body is over 4 KiB. A 500 is dropped like any other failure.

The server keeps whichever report **arrived** last, not the one the rig's clock
calls newest. If it ordered by the rig's clock, a clock stepped backwards would
freeze the row until the clock caught up, and a car still racing would drop off
the board. Arrival order is safe because the agent sends one report at a time.

## What the feed returns

`GET /api/race/live` is public, like the other feeds. The rules live in
[`apps/web/src/lib/race-live.ts`](../apps/web/src/lib/race-live.ts) and are
unit-tested there:

- It reads rows **received in the last 60 s**, judged by the database clock.
- It groups them by **session**: `SessionUniqueID` together with `SessionNum`.
  The **largest group is the race**. A tie goes to the group heard from most
  recently. `otherRigs` counts the rigs reporting from anywhere else, such as a
  rig still in practice or one that joined the wrong server.
- It orders by iRacing's **position**. A car iRacing has not classified yet
  goes after every classified car, by how far round it is.
- `session` is the leader's report: type, state, flags, time and laps
  remaining. It uses the first car that is still reporting, so a silent
  leader's frozen clock is never shown. `isRace` is true when the session type
  is exactly `Race`.
- `gapToLeaderS` and `intervalS` are only filled in a race. Outside one,
  iRacing puts a lap time in the same variable. `intervalS` is the gap to the
  row above, rounded to the millisecond and never negative. It is null for the
  leader, and null to or from a stale car.
- `ageS` is how long ago each rig's report arrived. `stale` is true past 15 s:
  show that row dimmed. A stale car keeps its last place, because usually only
  its agent stopped while the car is still out there. If another car reports
  that same place, the car still reporting goes first.
- `driverId` and `driverName` come from whoever is checked in on the rig right
  now. With nobody checked in they are null, and the board shows the rig by
  `rigNumber`.

**Number the board by `place`, not `position`.** Each rig samples its own car at
its own instant. Two neighbours that have just traded places can both report
the same position until the slower rig's next report, up to one cadence. Real
rigs in a hosted session do this as well as the fake ones. `place` is the
row's number in this ordering, from 1, and never repeats. While every car in
the race has an agent, it equals iRacing's position once both rigs have
reported.

Latency is the rig's cadence (2-3 s), plus the request, plus however often the
board polls. That is fast enough for a wall, but it is not a timing screen.

## Seeing it locally

The dev seed has three rigs. Check a driver in on two of them, at
`/r/demo-rig-1` and `/r/demo-rig-2` as in the root README's demo, and leave the
third empty so that both the driver join and the bare rig number show. Then
start three fake rigs in race mode. They compute the same race from the clock and each
reports its own car (`apps/web/scripts/fake-race.ts`):

```bash
cd apps/web
npm run fake-rig -- --token dev-rig-1-secret --race --car 0 --field 3
npm run fake-rig -- --token dev-rig-2-secret --race --car 1 --field 3
npm run fake-rig -- --token dev-rig-3-secret --race --car 2 --field 3
curl -s localhost:3000/api/race/live
```

Neighbours trade places every 20-40 s. Each race lasts `--race-minutes`
(default 20), ends with a minute under the chequered flag, and the next race is
a new session. Stop one rig to watch its row go stale and then drop out.

`npm run` only passes the flags on after the `--`. Under the twenty-rig
soak, `--race` drives one simulated race across every rig and checks the feed
once at the end of the hold ([soak-20-rigs.md](soak-20-rigs.md#running-it)).

## Not settled yet

- Nothing has read these variables on a real rig. Before the board is trusted,
  the agent's `--diagnose` must show, in a hosted session with at least two
  rigs: `SessionUniqueID` equal on both rigs, `SessionType` reading `Race` in
  the race, and `CarIdxF2Time[PlayerCarIdx]` counting seconds behind the
  leader. If `SessionUniqueID` turns out to be shared by every offline session,
  rigs in solo practice would form a group of their own. The largest group
  still wins, but that is worth seeing on the night.
- Twenty rigs reporting every 2.5 s is about eight requests a second during a
  race, which is several thousand serverless invocations an hour. Check that
  against the Vercel plan before the night.
- Positions only. A finishing order scored into the league is a later change
  with its own table.

Applying the migration to production: [deploy.md](deploy.md#applying-0008_race_statussql).
