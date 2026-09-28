# Phase 0 — venue-computer safety gate

Status: **GATE LIFTED BY THE PROJECT OWNER ON 2026-09-26.** The owner's words, deciding that the rig agent runs on Oasis computers for the 2026-09-27 off-site event: "disregard that rule we are past that. We need this to run". Running this project's software on Oasis computers no longer waits on this gate. Everything below stays as recorded guidance - read-only access to iRacing, no elevation, no writes to the sim, bounded resources - and as the checklist for a signed venue release when one is wanted; none of it is deleted, and none of it blocks the event build.

**Two things, kept apart.** The *event build* is the rig agent the owner approved to run on Oasis computers for the 2026-09-27 event; this gate does not apply to it. A *signed venue release* is the artifact this document describes - signed, hashed, VM-rehearsed and signed off - and every requirement, sign-off and "blocks" below is about that artifact only. Where a sentence below says an artifact may not run, or that the gate remains in progress, read it as "may not be called a signed venue release", not as a stop on the event build.

This gate protects equipment that Oasis owns and depends on. For a signed venue release, a passing build, a valid signature, or confidence in the source is not enough: the exact signed bytes must have complete off-site evidence and project-owner safety sign-off before the supervised canary in `spike-checklist.md`.

## What ran on Oasis computers, and when

- 2026-09-26: the project owner personally ran the rig agent read-only (`OasisRigAgent.exe --diagnose`) on the 2 rig computers Oasis is taking to the off-site event; it attached to iRacing and timed laps correctly (the log is on the pull request that added iRacing lap detection).
- 2026-09-26: the project owner lifted this gate for this project's software on Oasis computers ("disregard that rule we are past that. We need this to run") and decided the agent, with telemetry set to iracing, runs on the 2 event computers for the 2026-09-27 off-site event.

## Threat model

The recorder consumes untrusted, concurrently changing shared memory on a computer we do not own. Relevant failure classes are excessive access rights, simulator control messages, malformed offsets, disk exhaustion, runaway resource use, unintended network activity, persistent installation/state, child processes, security prompts, opaque dependencies, artifact substitution, and sensitive session metadata loss.

The gate does not claim that Windows creates no execution records. Windows may create normal Defender, event, compatibility, or prefetch state. The application itself must create only its bounded log directory beside the executable.

## Enforced recorder boundary

- Repository-owned telemetry parser; no `IRSDKSharper`, `YamlDotNet`, or other venue-project package reference.
- `Local\IRSDKMemMapFileName` opened with `MemoryMappedFileRights.Read`.
- View accessor opened with `MemoryMappedFileAccess.Read`.
- `Local\IRSDKDataValidEvent` opened with `SYNCHRONIZE` (`0x00100000`) only.
- No iRacing broadcast registration or `PostMessage` surface.
- No application network, registry, service, task, installer, auto-start, child-process, input-control, or configuration-write code.
- Refuses elevated execution and duplicate instances.
- No default recording mode and no user-overridable safety limits.
- Canary: 10 minutes/25 MiB. Full: 120 minutes/100 MiB.
- At least 500 MiB must be free on the executable volume.
- Shared-memory maximum 64 MiB; session payload maximum 4 MiB; variable maximum 4,096; session files maximum 256.
- Fixed generated output names beneath `spike-logs/<UTC run id>/` only.
- Raw session data is never transmitted and is handled as sensitive.

Stable process exit codes are `0` clean stop, `2` invalid arguments, `3` unsupported platform, `10` elevated execution refused, `11` duplicate instance, `12` output failure, `13` malformed shared memory, `14` log limit, and `15` internal/source failure. For a signed venue release candidate, a nonzero code never authorizes retrying or changing the venue computer; return to off-site diagnosis.

The self-contained executable includes Microsoft's .NET runtime. That runtime can contain unused framework implementations and import names—including networking or window-message support—even though the OasisSpike application assembly has no reference to or call path for them. Therefore a raw string/import search of the bundled runtime is not accepted as proof by itself: CI checks the application source/assembly boundary, and both VM rehearsals must independently demonstrate that `OasisSpike.exe` owns no network connection, child process, or control-message behavior.

## Evidence checklist

### Source and automated checks

- [ ] Venue project has zero `PackageReference` items.
- [ ] Architecture script rejects networking, process launch, persistence, broadcast, and writable-map APIs.
- [ ] Bounds tests cover negative, overflowed, truncated, excessive, duplicated, and unknown shared-memory data.
- [ ] Deterministic malformed-input tests complete without hang or escaped bounds exception.
- [ ] Recorder tests cover connection lifecycle, lap events, duration, output budget, failure exit, fixed paths, and complete concurrent JSONL records.
- [ ] Test-only synthetic publisher is absent from the venue package.
- [ ] Clean `Release` test and `win-x64` publish pass on the tagged commit.

### Signed candidate

- [ ] Azure Artifact Signing identity validation and public-trust profile are active, or the documented OV fallback is used.
- [ ] GitHub `venue-release` environment restricts deployment to `spike-v*` tags and holds only the signing identifiers required by the tag-gated job.
- [ ] Tag is annotated and matches the reviewed commit.
- [ ] Authenticode SHA-256 signature and RFC 3161 timestamp verify with no warning.
- [ ] Microsoft Defender custom scan of the exact signed executable is clean.
- [ ] `SHA256SUMS.txt` was generated after signing.
- [ ] `RELEASE-MANIFEST.json` records tag, commit, SDK, runtime, workflow, timestamp, and hash.
- [ ] Package status remains `SIGNED_CANDIDATE_NOT_YET_AUTHORIZED_FOR_VENUE_USE` until VM/review gates pass.

### Windows 11 x64 VM — run 1

- [ ] Fully patched clean snapshot and standard non-administrator user.
- [ ] Hash and Authenticode verification pass.
- [ ] Launching the exact signed `OasisSpike.exe --mode canary` command succeeds without SmartScreen bypass, UAC, firewall, or antivirus prompt.
- [ ] Current Defender definitions report no threat.
- [ ] Synthetic valid, malformed, reconnect, producer-exit, and recorder-stop cases exercised.
- [ ] No child process or application-owned network connection.
- [ ] Process Monitor writes from `OasisSpike.exe` are confined to its `spike-logs` subtree.
- [ ] No registry, service, task, startup, iRacing-file, or producer-memory mutation.
- [ ] Average CPU is below 5% of one logical core; working set below 150 MiB after warm-up.
- [ ] Handle count does not grow continuously.
- [ ] Duration, output, kill, shutdown, corruption, and disk-error behavior preserve earlier complete records.
- [ ] Removing the package/log directory removes all application-created state.

### Windows 11 x64 VM — restored run 2

- [ ] Restore the clean snapshot.
- [ ] Repeat with the exact signed SHA-256.
- [ ] Obtain the same result with no new warning or unexplained behavior.

### Project-owner safety sign-off

- [ ] Project owner examines the source boundary, requested Windows rights, parser bounds, tests, CI run, signature, hash, Defender result, VM evidence, and canary procedure.
- [ ] Project owner records PASS for the exact artifact without waiver.
- [ ] Completed report records owner identity, date, evidence location, and decision.
- [ ] Optional peer review may be recorded, but is not required and cannot waive a failed or unknown gate.

## Release setup still requiring external configuration

Repository code cannot create or truthfully complete these controls:

1. Create Azure Artifact Signing identity/certificate profile and GitHub OIDC trust. If unavailable, obtain a standard OV Authenticode certificate; never substitute self-signing.
2. Add the workflow's Azure identifiers and Artifact Signing names as protected environment secrets.
3. Configure the GitHub `venue-release` environment for `spike-v*` tags and environment-scoped signing identifiers.
4. Run the two Windows 11 VM rehearsals and retain Process Monitor, Defender, resource, signature, hash, and cleanup evidence.
5. Have the project owner complete `SAFETY-REPORT.md` for the exact candidate.

The automated portion of a rehearsal can be started with `spike/scripts/Invoke-VmRehearsal.ps1`, passing the signed-candidate directory, expected hash, expected Azure Trusted Signing subject from the release evidence, and the separately downloaded test-only synthetic publisher. The publisher must remain outside the signed venue package. Process Monitor, SmartScreen, Defender, snapshot-repeat, cleanup, and project-owner sign-off remain manual mandatory checks.

Until all five are done, no artifact is a signed venue release and Phase 0 remains in progress for it; the event build is outside this gate (see the top of this document).

The `venue-release` environment must provide `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_ARTIFACT_SIGNING_ENDPOINT`, `AZURE_ARTIFACT_SIGNING_ACCOUNT`, and `AZURE_ARTIFACT_SIGNING_PROFILE`. Authentication uses GitHub OIDC; do not create or store a client secret or signing private key in the repository. Restrict the environment to `spike-v*` tags.

## Data handling

Raw `sessioninfo-NNN.yaml` may contain account or driver identifiers. Keep the USB in project-owner custody, transfer to encrypted storage, verify the copy before wiping the USB, limit access to the owner and any explicitly designated peer reviewer, never upload automatically, and delete raw metadata 30 days after the findings/schema decisions are approved.

## Phase transition

This section governs the signed venue release only. Phase 0 completes only when every evidence item passes with no warning, unknown, or waiver and the project owner signs off on the exact SHA-256. Phase 1A is then limited to the supervised canary. Any executable-byte change invalidates the VM evidence and sign-off and returns the work to Phase 0.
