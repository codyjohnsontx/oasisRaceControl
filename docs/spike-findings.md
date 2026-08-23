# Phase 1 spike — findings

> Fill this in from `spike-logs/` after each venue session. The Phase 2 schema, validity rules,
> and idempotency key are frozen only when every row below has a verdict.
> Recording sessions: _(date / rig # / combo)_

## Approved artifact used for collection

- Recorder version: _(required)_
- Git commit: _(required)_
- SHA-256: _(required; must match the exact hash recorded in the project-owner safety sign-off)_
- Authenticode signing subject/timestamp: _(required)_
- Phase 1A canary approval/date: _(required)_
- Run directory name(s): _(required)_

## Field availability

| Product needs | Candidate SDK source | Verdict | Notes |
|---|---|---|---|
| Telemetry layout version | header `ver` (first 4 bytes), iRacing's own `IRSDK_VER` | ☐ | Read and required to equal 2 before any other field, since every offset below moves with it. Confirm the live install stamps 2; a rig publishing anything else reports `unreadable` naming both versions and `--check-sim` exits 6. |
| iRacing running/closed | SDK connect/disconnect events | ☐ | Disconnect latency after sim close? |
| Track identity | `WeekendInfo.TrackID`, `TrackName` | ☐ | Record `TrackDisplayName` **verbatim** - it is what staff have to type into the league round form for a lap to count. |
| Track configuration | `WeekendInfo.TrackConfigName` | ☐ | Empty string on single-config tracks? The agent reads empty as no layout; a layout typed into the round form for a track that has none voids the night until staff repoint it. Record verbatim. |
| Car identity | `DriverInfo.Drivers[PlayerCarIdx].CarID` (YAML) | ☐ | Confirm exact YAML path. Record `CarScreenName` **verbatim** - `Dallara IR18` vs `Dallara IR-18` is the whole difference between a league night and an empty board. |
| Car class | `CarClassID` / `CarClassShortName` (YAML) | ☐ | Meaningful in offline sessions? |
| Sim session identity | `SessionID`+`SubSessionID` or `SessionUniqueID` | ☐ | Values in offline/test sessions? Stable across recorder restart (scenario 8)? Reset on session restart (scenario 7)? **No longer load-bearing:** a lap's identity is namespaced by the agent's own run token, so a repeated `SessionUniqueID` costs nothing. The values are still worth recording, because they are what makes a lap id say which sim session it came from. |
| Lap number | `Lap` / `LapCompleted` | ☐ | Off-by-one behavior at boundary? |
| Completed lap time | `LapLastLapTime` | ☐ | **Record `LAP_TIME_SETTLED`.** Out-lap value? −1 or 0 when no time? And the question a single frame cannot answer: does the time move on the same tick as the counter, or a few ticks later? Reading it at the line under the second answer gives every lap the PREVIOUS lap's time, with no error anywhere and the driver's fastest lap - usually their last - missing from the board entirely. **No longer load-bearing:** the agent holds a lap until the channel moves off what it was holding before the line, so it is right under either answer (`apps/rig-agent/README.md`, "How a lap gets its own time"). The number is still worth having, because it is what the two-second settle window has to stay longer than. |
| Per-lap incidents | `PlayerCarMyIncidentCount` delta at boundary | ☐ | **0x rule depends on this.** Does an incident near the line attribute to the right lap? |
| Off-track detection | `PlayerTrackSurface` == 0, and/or incident 1x | ☐ | Are brief 4-offs visible at 10 Hz? Redundant with incident count? |
| Pit lane lap | `OnPitRoad` seen during lap | ☐ | |
| Reset to pits | `EnterExitReset` / `Lap` decrease / surface jump | ☐ | What exactly fires (scenario 6)? |
| Session restart | `SessionNum`/`SessionUniqueID`/lap reset | ☐ | Scenario 7. The lap counter returning to zero is handled without needing the answer: it starts a new run of lap numbers with its own token, so the second run cannot re-spend the first run's lap identities. |
| Fixed vs open setup | `WeekendOptions` (YAML) | ☐ | Available offline? |
| Idle rig signature | `IsOnTrack`, speed, session state over time | ☐ | Scenario 11 — pick auto-checkout signals |

## Edge-case behaviors

| Scenario | What happened | Design consequence |
|---|---|---|
| 3. Out lap boundary | | Does the first crossing create a junk "lap"? Filter rule: |
| 6. Reset mid-lap | | INCOMPLETE_LAP / SESSION_RESET detection rule: |
| 7. Session restart | | Sim-session row lifecycle: |
| 8. Recorder restart | | Reattach + dedupe strategy: |
| 9. Combo change | | New sim-session detection: |
| 10. Lap then quit | | Was the boundary captured? Queue-flush requirement: |
| 12. Lap time publication | | `LAP_BOUNDARY.timeMovedWithTheCounter` and `LAP_TIME_SETTLED.framesAfterTheLine` across a full stint. Settle window still long enough: |

## Decisions unlocked by this spike

- **Idempotency key** = **rig + agent run + run of lap numbers + lap number**, minted once by `LapDetector` and carried unchanged by the outbox (`lap-r12-s7-n0-l6-t1787164977292162e6495x2`). The sim's own `SessionUniqueID`/`SessionNum` are in the string so a lap says which sim session it came from, and are deliberately **not** what keeps two laps apart. The question mark in the original phrasing was the whole problem: rig + sim session + lap number was shipped, and it hands the next customer at that seat the identity of the last one's lap 6, whose only visible effect is that the second customer is not on the leaderboard. Driven for real, one rig and two customers on the same combo put 3 of 6 laps on the board; the same night with the run token puts 6 of 6 on it. See `apps/rig-agent/README.md`, "Why two laps never share an identity".
- **Lap validity rule (0x)** = **incidentDelta > 0 → invalid, AND offTrackSeen carried separately.** The two signals are not the same: iRacing charges no incident for a great many offs, so an incident-only rule lets a lap that ran wide at the fastest corner stand as the fastest clean lap of the night. The agent reports both and the backend (`apps/web/src/lib/validity.ts`) counts an uncharged off as one incident against the limit — `max`, not a sum — reporting it as `OFF_TRACK` so the reason matches what the driver sees on their own screen.

  A lap's stored validity says **only** whether the lap was clean. Whether it counts for tonight's featured combo is asked at read time (`v_fastest_tonight`, `v_league_round_laps`, `isOnCombo`), never frozen into the lap - because the combo is typed by a person against names this spike is here to establish, and a combo one character off would otherwise void a whole league night for good. See `AGENTS.md`, "A combo typed one character off the sim's own name". **The exact display names the live install publishes for `TrackDisplayName`, `TrackConfigName` and `CarScreenName` are therefore worth recording verbatim in the table above** - they are what staff have to reproduce in the round form.
- **A lap's own time** = **wait for `LapLastLapTime` to move off what it held before the line**, minted by `LapDetector` and bounded by a two-second settle window. Reading the channel on the crossing frame was shipped, and it is correct only if the sim publishes the time on the same tick as the counter - which nothing establishes. Under the other ordering every lap carries the previous lap's time, with every rig green and the driver's fastest lap (usually their last) absent from the board entirely. Recording `LAP_TIME_SETTLED.framesAfterTheLine` is what confirms the window is still long enough; the agent is right either way in the meantime.
- **Auto-checkout idle signal** = _(fill in)_:
- **Library verdict**: IRSDKSharper 1.1.9 — ☐ keep / ☐ replace because:
- **Schema freeze**: ☐ GO / ☐ NO-GO — blockers:
