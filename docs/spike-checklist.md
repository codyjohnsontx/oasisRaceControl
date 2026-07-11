# Phase 1 spike — on-site recording checklist

Goal: prove what iRacing's local SDK actually exposes on a real Oasis rig. Every scenario below produces data in `spike-logs/` that answers a specific design question. Budget ~60–90 minutes on one rig.

## Before you go

- [ ] Copy `OasisSpike.exe` (from `spike/OasisSpike/bin/Release/net8.0-windows/win-x64/publish/`) to a USB drive or the rig.
- [ ] Bring this checklist (phone or paper) — note the wall-clock time next to each scenario as you run it.

## Setup on the rig

- [ ] Confirm `irsdkEnableMem=1` in `Documents\iRacing\app.ini` (it's the default; only check if nothing connects).
- [ ] Run `OasisSpike.exe` from a folder you can write to (it creates `spike-logs\<timestamp>\` next to itself).
- [ ] **Use the marker feature**: before each scenario, type `m` + Enter in the console, then a note like `scenario 3 start`. This stamps your notes into the event log.

## Scenarios

Each scenario: drop a marker, do the thing, watch the console, drop a closing marker.

### 1. Cold connect
Start the recorder **before** launching iRacing. Launch iRacing into tonight's combo.
*Proves:* CONNECTED fires, `telemetry-vars.txt` is written, `missingWatchedVars` tells us which desired fields don't exist.

### 2. Session identity
Note the track/car/session shown in the first `SESSION_INFO` console line.
*Proves:* TrackID/TrackConfigName/SessionID/SubSessionID availability for local (non-official) sessions — the raw material for idempotency keys. **Open question: are SessionID/SubSessionID 0 or meaningful in offline/test sessions?**

### 3. Three clean laps
Drive 3 laps as cleanly as you can.
*Proves:* LAP_BOUNDARY events fire with sane `lapTimeMs`, `incidentDelta: 0`, `offTrackSeen: false`. Also note whether the **out lap** (pit exit → first line crossing) produces a boundary and what its time looks like.

### 4. Deliberate off-track
On the next lap, put all four wheels off track once, then finish the lap.
*Proves:* whether an off-track shows as `PlayerTrackSurface` change, an incident count bump (1x), or both — and whether `incidentDelta`/`offTrackSeen` land on the correct lap. This is the make-or-break for the 0x rule.

### 5. Contact incident
Tap a wall gently on the following lap.
*Proves:* incident count bump size for contact (2x/4x) and correct lap attribution.

### 6. Reset to pits mid-lap
Start a lap, then reset to pits (ESC → tow/reset) mid-lap. Drive one more clean lap after.
*Proves:* what happens to Lap/LapCompleted/LapDistPct on reset (`resetSeen`, `LAP_COUNTER_RESET`?), whether the aborted lap produces any boundary, and whether the next lap's time is trustworthy.

### 7. Session restart
Restart the session from the iRacing menu (or advance to next session if it's a practice).
*Proves:* whether SessionNum/SessionUniqueID/LapCompleted reset — this decides how the agent detects "same physical sitting, new sim session".

### 8. Recorder restart mid-session
Quit the recorder (`q` + Enter), relaunch it while iRacing stays running, drive one lap.
*Proves:* clean reattach, and whether session identity reads the same after reattach (idempotency across agent restarts).

### 9. Change combo
Exit to the iRacing UI, load a **different track or car**, enter the session.
*Proves:* DISCONNECTED/CONNECTED sequencing (does the sim process restart?), fresh SESSION_INFO with new TrackID/car.

### 10. Lap completes right before exit
Drive a lap and quit iRacing within ~2 seconds of crossing the line.
*Proves:* whether the final LAP_BOUNDARY is captured before DISCONNECTED — the "lap right before close" edge case.

### 11. Idle
Leave iRacing running, sitting in the car or garage, untouched for 3+ minutes.
*Proves:* what an "idle" rig looks like in telemetry (IsOnTrack, speed, session state) — feeds the auto-checkout heuristics.

### 12. Full close
Quit iRacing entirely. Wait 30s. 
*Proves:* DISCONNECTED timing and recorder stability with no sim.

## After

- [ ] `q` + Enter to stop the recorder.
- [ ] Copy the whole `spike-logs\` folder off the rig (zip it; it should be a few MB).
- [ ] Note anything weird you saw that the console didn't seem to capture.

Back home: fill in `docs/spike-findings.md` from the logs.
