# Oasis Race Control

In-store driver check-in, live timing, lap history, leaderboard, and weekly league platform for **Oasis Sim Racing** — a venue with ~20–25 Windows iRacing simulators.

Customer flow: **scan the rig's QR code → confirm check-in on your phone → drive.** Laps are captured automatically, attributed to the checked-in driver, and shown on the driver's phone, the staff dashboard, and the front-of-store TV leaderboard (**Oasis Live Timing**).

## League night

The Wednesday in-house league. Staff open a round from `/staff` against one track/car combo; every lap driven on that combo while the round is open belongs to that round, so drivers just check in and drive as usual. Rounds roll up into a season, and a season is a calendar month.

- `/league` — season standings across every round, with each driver's per-round breakdown and a strip of rounds to tap into. Open rounds are included, so the board moves while the night is running.
- `/league/[roundId]` — one round's full field ranked by fastest valid lap; tap a driver to expand all of their laps. Phone-first, this is the post-race comparison.
- `/tv` — the front-of-store TV carries a league standings board in its rotation, and while a round is open that board takes the screen over: league night owns the wall, the arcade boards have it the rest of the week. Nobody has to take the kiosk off rotation.
- `/staff` — open a round against a combo, close it when the night is over, and at the turn of the month end the season and start the next one (named for the month, in one step, refused while a round is still open).

**Opening a round also sets that day's featured combo to the round's combo**, because lap validity is judged against the featured combo when a lap is ingested; closing the round puts the previous combo back. Laps already logged keep the validity they were given.

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
- **Phase 2 (simulated web/API slice): substantially built in parallel.** Check-in, driver portal, TV leaderboard, staff dashboard, league night, ingestion API, fake-rig simulator, and most non-telemetry agent infrastructure work. Real iRacing lap detection and the Windows agent UI remain incomplete.

## Web app development

The database is plain Postgres — **Neon** in production, any local Postgres in dev. All access is server-side (`docs/plan.md` has the access paths); there is no realtime service (the TV and portal poll every few seconds, which is indistinguishable from push at venue scale).

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
npm test           # unit tests, plus the league lifecycle suite when a local database is reachable
npm run db:check   # read-only: is DATABASE_URL's database behind db/migrations?
npm run db:migrate # apply any new migrations in db/migrations/
```

### Integration tests

`npm test` covers pure logic and the API routes' auth/validation branches. The
guarantees that live in Postgres - the `event_id` idempotency key, the
one-open-assignment-per-rig/driver partial unique indexes, and the
`checkin_driver()` function - are covered by a separate suite that needs a real
database:

```bash
docker start oasis-pg   # or: docker run -d --name oasis-pg -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:16
docker exec oasis-pg psql -U postgres -c 'create database oasis_test'

export TEST_DATABASE_URL="postgres://postgres:postgres@localhost:5433/oasis_test"
npm run test:integration
```

The suite **skips** (it does not fail) when `TEST_DATABASE_URL` is unset, so
`npm test` and CI stay green without Postgres. It reads only
`TEST_DATABASE_URL` - never `DATABASE_URL` - because these tests truncate every
table and `.env.local` normally points at live Neon. The URL must be a local
host with `test` in the database name; managed hosts are refused outright before
any connection is opened (`src/test/db-guard.ts`). Migrations are reapplied from
scratch on each run, so a schema change can never leave the test database stale.

One real-database suite runs under plain **`npm test`** rather than
`test:integration`: `src/lib/league-round-lifecycle.test.ts`, which covers league
night's effect on the rest of the venue day and the round/season concurrency
rules. It builds its **own** throwaway database from `db/migrations` and drops it
afterwards, so it never truncates anything you already have. It prefers
`TEST_DATABASE_URL` and otherwise falls back to a local `DATABASE_URL`,
rewriting either to that scratch database. Both paths go through the same
`db-guard.ts` refusals - managed hosts, non-local hosts, and redirecting
connection parameters - applied to the scratch URL before any connection opens.
An explicit but unsafe `TEST_DATABASE_URL` is a hard error; an unusable
`DATABASE_URL` just skips the suite, which is why it is quiet on a machine
pointed at Neon. Nothing loads `.env.local` for tests, so give it a URL:

```bash
TEST_DATABASE_URL="postgres://postgres:postgres@localhost:5433/oasis_test" npm test
```

Demo: open `/r/demo-rig-1` on your phone (or localhost), check in as a guest, start `npm run fake-rig`, and watch laps land on `/me` and `/tv`. Check in **first**: like the real agent, the fake rig polls `GET /api/agent/assignment` and stamps each lap with the assignment that was open when it was driven, and the ingestion API refuses a lap that carries none rather than crediting it to the next person to check in (`docs/plan.md`, event model). Laps driven before you check in stay refused - they are not backfilled once you do. Staff dashboard is at `/staff`. To try league night, open a round from `/staff` against the combo the fake rig drives, then watch `/league` and the round's page fill up.

## Building an unsigned spike test candidate

This produces an **off-site test artifact only**. Do not take a locally built or unsigned executable to Oasis. Venue candidates must come from the protected `spike-v*` signing workflow and complete every gate in `docs/venue-safety.md`.

```bash
export PATH="$HOME/.dotnet:$PATH"
dotnet test spike/OasisSpike.sln -c Release
dotnet publish spike/OasisSpike/OasisSpike.csproj -c Release -r win-x64 --self-contained -p:PublishSingleFile=true
```

The venue-facing interface has no default run mode: `--mode canary` enforces 10 minutes/25 MiB and `--mode full` enforces 120 minutes/100 MiB. Never inspect or edit iRacing configuration during the canary. A failure to connect is a stop-and-reschedule result.
