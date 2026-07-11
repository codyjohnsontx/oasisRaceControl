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

## Status

- **Phase 1 (iRacing spike): awaiting a venue recording session.** The `laps` table and agent event contract are provisional until the spike findings land. See `docs/spike-checklist.md`, `docs/spike-findings.md`, and `spike/`.
- **Phase 2 (web slice): built.** Check-in, driver portal, TV leaderboard, staff dashboard, ingestion API, and a fake-rig simulator.

## Web app development

One-time setup:

1. Create a Supabase project → copy `apps/web/.env.example` to `apps/web/.env.local` and fill it in.
2. Apply the schema: `supabase login`, `supabase link --project-ref <ref>`, `supabase db push`, then paste `supabase/seed.sql` into the SQL editor (dev data: rigs 1–3, QR tokens `demo-rig-1..3`, drivers with PIN 1234, tonight's featured combo).
3. First staff user: Supabase dashboard → Authentication → Add user, then insert a `staff_users` row (snippet at the bottom of `seed.sql`).
4. Vercel: import this repo, set root directory to `apps/web`, paste the same env vars.

Daily loop:

```bash
cd apps/web
npm run dev        # http://localhost:3000
npm run fake-rig   # simulates Rig 01 sending heartbeats + laps (needs dev seed)
npm test           # unit tests
```

Demo: open `/r/demo-rig-1` on your phone (or localhost), check in as a guest, start `npm run fake-rig`, and watch laps land on `/me` and `/tv` live. Staff dashboard is at `/staff`.

## Building the spike recorder (on this Mac, runs on Windows)

```bash
export PATH="$HOME/.dotnet:$PATH"
cd spike/OasisSpike
dotnet publish -c Release -r win-x64 --self-contained -p:PublishSingleFile=true
# copy bin/Release/net8.0-windows/win-x64/publish/OasisSpike.exe to the rig (no .NET install needed there)
```

On the rig: ensure `irsdkEnableMem=1` in iRacing's `app.ini` (it is the default), run `OasisSpike.exe`, drive the checklist scenarios, then copy the `spike-logs/` folder back for analysis.
