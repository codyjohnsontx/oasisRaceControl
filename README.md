# Oasis Race Control

In-store driver check-in, live timing, lap history, and leaderboard platform for **Oasis Sim Racing** — a venue with ~20–25 Windows iRacing simulators.

Customer flow: **scan the rig's QR code → confirm check-in on your phone → drive.** Laps are captured automatically, attributed to the checked-in driver, and shown on the driver's phone, the staff dashboard, and the front-of-store TV leaderboard (**Oasis Live Timing**).

## Repository layout

```
apps/web/            # Next.js — driver portal, staff dashboard, TV leaderboard, API (Phase 2)
apps/rig-agent/      # .NET 8 Windows agent that runs on every simulator (Phase 2)
packages/shared/     # Event schemas and shared types (Phase 2)
db/                  # SQL migrations + dev seed (Postgres — Neon in prod)
spike/               # Phase 1 throwaway telemetry recorder — proves iRacing SDK ground truth
docs/                # Plan, spike checklist, spike findings, ops runbook
```

## Status

- **Phase 0 (off-site venue safety gate): in progress and blocking all Oasis execution.** The recorder has a repository-owned, dependency-free read-only telemetry path and bounded logging, but it is **not authorized for venue use** until a signed candidate passes two clean Windows 11 VM rehearsals and project-owner safety sign-off. See `docs/venue-safety.md`.
- **Phase 1 (Oasis canary + iRacing spike): blocked by Phase 0.** The `laps` table and agent event contract remain provisional until an approved canary and recording session complete. See `docs/spike-checklist.md`, `docs/spike-findings.md`, and `spike/`.
- **Phase 2 (simulated web/API slice): substantially built in parallel.** Check-in, driver portal, TV leaderboard, staff dashboard, ingestion API, fake-rig simulator, and most non-telemetry agent infrastructure work. Real iRacing lap detection and the Windows agent UI remain incomplete.

## Web app development

The database is plain Postgres — **Neon** in production, any local Postgres in dev. All access goes through the Next.js API routes; there is no realtime service (the TV and portal poll every few seconds, which is indistinguishable from push at venue scale).

One-time setup:

1. Database:
   - **Local**: `docker run -d --name oasis-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=oasis -p 5433:5432 postgres:16`
   - **Neon**: create a project at neon.tech and copy the **pooled** connection string (the `-pooler` host, with `sslmode=require`).
2. Copy `apps/web/.env.example` to `apps/web/.env.local` and fill in `DATABASE_URL` and `SESSION_SECRET`.
3. Apply schema + dev data: `npm run db:migrate && npm run db:seed` (from `apps/web`). Seed data: rigs 1–3, QR tokens `demo-rig-1..3`, drivers with PIN 1234, staff login `staff@oasis.test` / `oasis-staff-demo`, tonight's featured combo. **The seed is for local/demo environments only** — its rig tokens, QR slugs, PINs, and staff password are deliberately guessable. In production, run only `db:migrate`, enroll rigs with random tokens (`openssl rand -hex 32`), and insert real staff rows with strong bcrypt-hashed passwords.
4. Vercel: import this repo, set root directory to `apps/web`, add the same two env vars (use the Neon pooled URL).

Daily loop:

```bash
cd apps/web
npm run dev        # http://localhost:3000
npm run fake-rig   # simulates Rig 01 sending heartbeats + laps (needs dev seed)
npm test           # unit tests
npm run db:migrate # apply any new migrations in db/migrations/
```

Demo: open `/r/demo-rig-1` on your phone (or localhost), check in as a guest, start `npm run fake-rig`, and watch laps land on `/me` and `/tv`. Staff dashboard is at `/staff`.

## Building an unsigned spike test candidate

This produces an **off-site test artifact only**. Do not take a locally built or unsigned executable to Oasis. Venue candidates must come from the protected `spike-v*` signing workflow and complete every gate in `docs/venue-safety.md`.

```bash
export PATH="$HOME/.dotnet:$PATH"
dotnet test spike/OasisSpike.sln -c Release
dotnet publish spike/OasisSpike/OasisSpike.csproj -c Release -r win-x64 --self-contained -p:PublishSingleFile=true
```

The venue-facing interface has no default run mode: `--mode canary` enforces 10 minutes/25 MiB and `--mode full` enforces 120 minutes/100 MiB. Never inspect or edit iRacing configuration during the canary. A failure to connect is a stop-and-reschedule result.
