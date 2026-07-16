# Phase 1 — Oasis canary and telemetry recording checklist

This checklist is blocked until every Phase 0 item in [venue-safety.md](./venue-safety.md) passes for the exact signed executable and SHA-256. A local build, unsigned build, changed executable, incomplete safety report, warning, or waiver is a stop condition.

## Artifact record

- Version: __________
- Git commit: __________
- SHA-256: __________
- Signing subject: __________
- Project-owner safety sign-off/date: __________
- Oasis-approved time, rig, and operator: __________

## Phase 1A — supervised canary

### Prerequisites

- [ ] Obtain explicit Oasis permission for the time, idle rig, and operator.
- [ ] Bring the controlled USB; do not copy the recorder onto the venue PC.
- [ ] Verify the Authenticode signature and SHA-256 against the reviewed report.
- [ ] Confirm the VM report contains two clean-snapshot passes and project-owner safety sign-off.
- [ ] Confirm the rig is idle and outside customer use.
- [ ] Establish normal Task Manager CPU/memory and normal iRacing behavior.
- [ ] Confirm the operator will not enter administrator credentials, approve a security bypass, or change settings.

### Canary procedure

1. Run `OasisSpike.exe --mode canary` from the USB as the normal signed-in user.
2. Observe for two minutes with iRacing closed.
3. Launch iRacing normally. Do not inspect or edit `Documents\iRacing\app.ini`.
4. Observe telemetry connection, Task Manager resources, controls, audio, video, and simulator responsiveness for five minutes.
5. Press `Q` + Enter. Confirm prompt exit and a final `run-manifest.json` on the USB.
6. Confirm recorder logs exist only in `spike-logs` beside the USB executable.
7. Review `events.jsonl` and the manifest before authorizing Phase 1B.

### Immediate abort conditions

Abort on any UAC, administrator, firewall, SmartScreen, or antivirus prompt; requested setting change; iRacing crash/stutter/input/audio/UI change; unexpected process, file, or network behavior; CPU or memory outside the approved evidence bounds; malformed-data errors; failure to stop promptly; or any Oasis staff concern.

On abort: stop the process, remove the USB only after it stops, make no corrective change on the rig, document the observation, and return to Phase 0. If telemetry does not connect, stop and reschedule; do not diagnose by editing venue configuration.

### Canary authorization

- [ ] Exact SHA-256 still matches.
- [ ] Recorder stopped cleanly.
- [ ] Rig and iRacing remained normal.
- [ ] No safety/security prompt or configuration change occurred.
- [ ] Output remained confined to the USB.
- [ ] Project owner recorded PASS: __________ / date: __________

## Phase 1B — controlled telemetry spike

Use the same approved executable and SHA-256. Budget 60–90 minutes. Start with:

```text
OasisSpike.exe --mode full
```

Before and after each scenario, type `M` + Enter and a concise marker. Note wall-clock times separately.

### 1. Cold connect

Start the recorder before launching iRacing; then launch the approved test session.

Proves: connection event, safe wait behavior, variable dump, and missing desired fields.

### 2. Session identity

Record the displayed track/car/session and correlate it to raw `sessioninfo-NNN.yaml`.

Proves: TrackID, TrackConfigName, SessionID/SubSessionID, player car identity, and offline-session values.

### 3. Three clean laps

Drive three clean laps and note the out-lap boundary.

Proves: lap time, boundary, incident delta zero, and surface history.

### 4. Deliberate off-track

Put all four wheels off once, then finish the lap.

Proves: surface transition versus incident count and correct lap attribution.

### 5. Contact incident

Tap a wall gently and finish the lap.

Proves: contact incident delta and boundary attribution.

### 6. Reset to pits mid-lap

Reset/tow mid-lap and then drive one clean lap.

Proves: counter rollback, aborted-lap behavior, and next-lap trustworthiness.

### 7. Session restart

Restart or advance the iRacing session.

Proves: session identifiers and counter lifecycle.

### 8. Recorder restart mid-session

Stop with `Q`, verify clean exit, relaunch the exact same executable in `--mode full`, and drive one lap.

Proves: read-only reattachment and stable session identity. Record both run directories.

### 9. Change combo

Exit normally and load a different track or car.

Proves: disconnect/reconnect sequence and new session metadata.

### 10. Lap completes right before exit

Quit iRacing normally within roughly two seconds of crossing the line.

Proves: final boundary delivery before disconnect.

### 11. Idle signature

Leave the session untouched for at least three minutes.

Proves: read-only idle signals for later agent design.

### 12. Full close

Quit iRacing and wait 30 seconds.

Proves: disconnect timing and recorder stability without the simulator.

## After recording

- [ ] Stop with `Q`; confirm manifest state and exit code.
- [ ] Keep the USB under project-owner control.
- [ ] Transfer logs to encrypted storage on a trusted computer.
- [ ] Verify the transferred archive before wiping the USB copy.
- [ ] Restrict raw metadata to the project owner and any explicitly designated peer reviewer.
- [ ] Complete `docs/spike-findings.md` with the exact version and SHA-256.
- [ ] Delete raw metadata 30 days after findings and schema decisions are approved.
