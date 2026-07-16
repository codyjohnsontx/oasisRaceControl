# Venue canary checklist

Artifact version: __________  SHA-256: __________  Date: __________  Rig: __________

## Prerequisites

- [ ] Oasis explicitly approved this time, rig, and operator.
- [ ] Rig is idle and outside customer use.
- [ ] Signature is valid and SHA-256 matches `SHA256SUMS.txt`.
- [ ] `SAFETY-REPORT.md` is complete and independently approved.
- [ ] Program is running from the controlled USB as a normal user.
- [ ] No files were copied to the venue PC and no settings were changed.

Verify from a normal PowerShell window opened on the USB directory:

```powershell
Get-AuthenticodeSignature .\OasisSpike.exe
Get-FileHash .\OasisSpike.exe -Algorithm SHA256
```

The signature status must be `Valid`; the hash must exactly match the independently reviewed value. Any warning, lookup failure, or mismatch is an abort—do not bypass it.

## Canary

- [ ] Start `OasisSpike.exe --mode canary` with iRacing closed.
- [ ] Observe normal rig behavior for two minutes.
- [ ] Launch iRacing normally; do not inspect or edit `app.ini`.
- [ ] Observe connection and normal simulator behavior for five minutes.
- [ ] Confirm Task Manager stays within the approved CPU/memory bounds.
- [ ] Stop with `Q` and confirm the process exits promptly.
- [ ] Confirm recorder logs exist only on the USB.
- [ ] Review `run-manifest.json` and `events.jsonl` before full-spike authorization.

## Immediate abort conditions

Abort for any UAC, administrator, firewall, SmartScreen, or antivirus prompt; any
requested setting change; any iRacing crash, stutter, input/audio/UI change;
unexpected process, file, or network behavior; excessive resources; repeated
malformed-data errors; failure to stop; or any Oasis staff concern.

On abort: stop the process, remove the USB only after it has stopped, make no
corrective change on the rig, document the observation, and return to Phase 0.

Canary result: PASS / ABORT    Operator: __________    Oasis witness: __________
