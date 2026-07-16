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
| iRacing running/closed | SDK connect/disconnect events | ☐ | Disconnect latency after sim close? |
| Track identity | `WeekendInfo.TrackID`, `TrackName` | ☐ | |
| Track configuration | `WeekendInfo.TrackConfigName` | ☐ | Empty string on single-config tracks? |
| Car identity | `DriverInfo.Drivers[PlayerCarIdx].CarID` (YAML) | ☐ | Confirm exact YAML path |
| Car class | `CarClassID` / `CarClassShortName` (YAML) | ☐ | Meaningful in offline sessions? |
| Sim session identity | `SessionID`+`SubSessionID` or `SessionUniqueID` | ☐ | Values in offline/test sessions? Stable across recorder restart (scenario 8)? Reset on session restart (scenario 7)? |
| Lap number | `Lap` / `LapCompleted` | ☐ | Off-by-one behavior at boundary? |
| Completed lap time | `LapLastLapTime` | ☐ | Out-lap value? −1 or 0 when no time? |
| Per-lap incidents | `PlayerCarMyIncidentCount` delta at boundary | ☐ | **0x rule depends on this.** Does an incident near the line attribute to the right lap? |
| Off-track detection | `PlayerTrackSurface` == 0, and/or incident 1x | ☐ | Are brief 4-offs visible at 10 Hz? Redundant with incident count? |
| Pit lane lap | `OnPitRoad` seen during lap | ☐ | |
| Reset to pits | `EnterExitReset` / `Lap` decrease / surface jump | ☐ | What exactly fires (scenario 6)? |
| Session restart | `SessionNum`/`SessionUniqueID`/lap reset | ☐ | Scenario 7 |
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

## Decisions unlocked by this spike

- **Idempotency key** = _(fill in — e.g. rigId + sessionUniqueId? + sessionNum + lapCompleted)_:
- **Lap validity rule (0x)** = _(fill in — incidentDelta > 0 → invalid? offTrackSeen separate?)_:
- **Auto-checkout idle signal** = _(fill in)_:
- **Library verdict**: IRSDKSharper 1.1.9 — ☐ keep / ☐ replace because:
- **Schema freeze**: ☐ GO / ☐ NO-GO — blockers:
