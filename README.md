# Oasis Race Control

In-store driver check-in, live timing, lap history, and leaderboard platform for **Oasis Sim Racing** — a venue with ~20–25 Windows iRacing simulators.

Customer flow: **scan the rig's QR code → confirm check-in on your phone → drive.** Laps are captured automatically, attributed to the checked-in driver, and shown on the driver's phone, the staff dashboard, and the front-of-store TV leaderboard (**Oasis Live Timing**).

## Repository layout

```
apps/web/            # Next.js — driver portal, staff dashboard, TV leaderboard, API (Phase 2)
apps/rig-agent/      # .NET 8 Windows agent that runs on every simulator (Phase 2)
packages/shared/     # Event schemas and shared types (Phase 2)
supabase/            # Database migrations (Phase 2)
spike/               # Phase 1 throwaway telemetry recorder — proves iRacing SDK ground truth
docs/                # Plan, spike checklist, spike findings, ops runbook
```

## Current phase: Phase 1 — iRacing integration spike

Nothing downstream (schema, validity rules, idempotency keys) is final until the spike proves what iRacing's local SDK actually exposes on a real venue rig. See:

- `docs/spike-checklist.md` — the scripted on-site recording session
- `docs/spike-findings.md` — findings template to fill in as scenarios are recorded
- `spike/` — the telemetry recorder to run on a rig

## Building the spike recorder (on this Mac, runs on Windows)

```bash
export PATH="$HOME/.dotnet:$PATH"
cd spike/OasisSpike
dotnet publish -c Release -r win-x64 --self-contained -p:PublishSingleFile=true
# copy bin/Release/net8.0-windows/win-x64/publish/OasisSpike.exe to the rig (no .NET install needed there)
```

On the rig: ensure `irsdkEnableMem=1` in iRacing's `app.ini` (it is the default), run `OasisSpike.exe`, drive the checklist scenarios, then copy the `spike-logs/` folder back for analysis.
