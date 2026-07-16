# Signed candidate safety report

Status: **NOT AUTHORIZED FOR VENUE USE** until every item is complete without waiver.

Candidate SHA-256: _pending_  Commit: _pending_  Workflow: _pending_

## Automated evidence

- [ ] Architecture boundary check passed.
- [ ] All parser, recorder, and output tests passed.
- [ ] Venue executable contains no third-party package assembly.
- [ ] Authenticode signature and timestamp verified without warning.
- [ ] Microsoft Defender custom scan passed cleanly.

## Windows 11 VM — clean snapshot run 1

- [ ] Standard non-administrator account; no UAC.
- [ ] Default launch policy allowed execution without bypass.
- [ ] No child process or application-owned network connection.
- [ ] Process Monitor writes confined to `spike-logs` beside the executable.
- [ ] No registry, service, task, startup, iRacing-file, or producer-memory mutation.
- [ ] CPU, memory, and handle growth stayed within documented bounds.
- [ ] Graceful stop, kill, corrupt map, producer crash, and disk failure behaved safely.

Evidence location and owner notes: _pending_

## Windows 11 VM — restored snapshot run 2

- [ ] Exact same signed SHA-256 used.
- [ ] All run-1 checks repeated with the same result.

Evidence location and owner notes: _pending_

## Project-owner safety sign-off

- [ ] Read-only access and parser bounds checked.
- [ ] Evidence and exact artifact checked.
- [ ] Canary procedure and abort conditions checked.
- [ ] Every gate is PASS with no warning, unknown, or waiver.

Project owner: _pending_  Date: _pending_  Decision: _pending_

Optional peer reviewer/notes: _not required_
