# Oasis Rig Agent

The lightweight app that runs on each simulator. It knows the rig's identity,
shows the current driver, and reliably ships completed laps to the backend even
across network drops and restarts.

## Status: skeleton

Everything **except lap detection** is built and verified end-to-end against the
live backend:

- ✅ Per-rig config + bearer-token auth
- ✅ Heartbeat (rig shows online on the staff dashboard)
- ✅ Current-driver display (polls the assignment)
- ✅ Durable, idempotent lap outbox (SQLite) — survives outages and restarts
- ✅ "Switch driver / sign out" (ends the assignment)
- ⏳ **Lap detection** — stubbed behind `ITelemetrySource`. The real iRacing
  source is built after the Phase 0 safety gate, Phase 1A supervised canary,
  and Phase 1B telemetry spike freeze the contract (`docs/venue-safety.md` and
  `docs/spike-findings.md`). `SimulatedTelemetrySource` stands in for testing.

The current host is a **console app** (runs on macOS/Linux/Windows, so it can be
tested anywhere). A tray-icon + status-window Windows shell is a later UI pass
that wraps the same `OasisRigAgent.Core`.

## Projects

```text
OasisRigAgent.Core    # cross-platform: config, queue, backend client, orchestrator
OasisRigAgent         # console host
OasisRigAgent.Tests   # xUnit (queue reliability + client contract)
```

## Configure

Copy `OasisRigAgent/agent.config.sample.json` to `agent.config.json` beside the
executable, or use env vars (which override the file):

| File key | Env var | Meaning |
|---|---|---|
| `backendBaseUrl` | `OASIS_BACKEND_URL` | e.g. `https://oasis-race-control.vercel.app` |
| `rigToken` | `OASIS_RIG_TOKEN` | the rig's secret bearer token |
| `rigNumber` | `OASIS_RIG_NUMBER` | e.g. `1` |
| `simulateTelemetry` | `OASIS_SIMULATE=1` | emit fake laps (testing only) |

## Run (from source)

```bash
export PATH="$HOME/.dotnet:$PATH"
cd apps/rig-agent
dotnet test                          # unit tests
OASIS_BACKEND_URL=https://oasis-race-control.vercel.app \
OASIS_RIG_TOKEN=dev-rig-1-secret OASIS_RIG_NUMBER=1 OASIS_SIMULATE=1 \
  dotnet run --project OasisRigAgent -c Release
```

`s` + Enter switches driver, `q` quits.

## Build the Windows exe

```bash
cd apps/rig-agent/OasisRigAgent
dotnet publish -c Release -r win-x64 --self-contained -p:PublishSingleFile=true
# → bin/Release/net8.0/win-x64/publish/OasisRigAgent.exe  (no .NET install needed on the rig)
```

## Verified

Run end-to-end against the live Vercel + Neon backend: the agent connected,
polled and displayed the checked-in driver, queued simulated laps, flushed them
(pending count returned to zero), and the laps appeared on the production
leaderboard. Queue reliability (idempotency, oldest-first, restart survival) and
the backend client's result mapping are covered by 11 unit tests.
