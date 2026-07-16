# Deploy runbook

How to put Oasis Race Control in production: the web app on Vercel, the
database on Neon, and a rig agent on each simulator. See
[architecture.md](./architecture.md) for how the pieces talk to each other.

Only the web app is "deployed" in the cloud sense. The agent is installed on
each sim PC, and the TV is just a browser pointed at `/tv`.

---

## 1. Database (Neon)

The app expects an already-migrated Postgres. Vercel does **not** run migrations
on deploy, so the database has to be ready first.

**If reusing the existing dev Neon database** (already migrated + seeded): skip
to step 2. Note that the demo data and demo logins will be live on the public
site — see step 4.

**If standing up a fresh production database:**

1. Create the database/branch in Neon.
2. Put the pooled connection string in `apps/web/.env.local` — gitignored, and it
   keeps the credential out of your shell history. The migration scripts load it
   automatically. (Or source it from your secret manager into the environment;
   just don't paste it inline on the command line.)

   ```bash
   # apps/web/.env.local
   DATABASE_URL=<neon pooled url>
   ```

3. From `apps/web`, run the migrations (and optional demo seed):

   ```bash
   npm run db:migrate
   npm run db:seed   # optional demo data: drivers, rigs, staff login
   ```

4. Use the **pooled** connection string — the host with `-pooler` in it, plus
   `sslmode=require`. Serverless functions each open their own pool, and the
   pooler is what keeps that from exhausting Postgres.

---

## 2. Web app (Vercel)

The repo is a monorepo; the app lives in `apps/web`.

1. **Vercel → Add New → Project → Import** `codyjohnsontx/oasisRaceControl`.
2. **Root Directory: `apps/web`.** This is the one setting that matters. Framework
   auto-detects as Next.js; leave build and install commands at their defaults
   (no `vercel.json` needed).
3. **Environment Variables:**

   | Key | Value | Notes |
   |---|---|---|
   | `DATABASE_URL` | Neon **pooled** connection string | `-pooler` host, `sslmode=require`. Server-only — never `NEXT_PUBLIC_`. |
   | `SESSION_SECRET` | long random string | signs driver + staff cookies. Generate: `openssl rand -base64 48` |

   Both are read lazily on the request paths that use them — a missing
   `DATABASE_URL` throws the first time a route touches the database, and a
   missing `SESSION_SECRET` throws the first time a session is signed or read.
   Hit the site after deploying (or add a health check) to surface a bad config.
4. **Deploy.** Note the assigned domain (e.g. `oasis-race-control.vercel.app`);
   the agents need it in step 3.

---

## 3. Rig agent (each sim PC)

The agent runs on every simulator and ships laps outbound to the Vercel app —
no inbound connectivity to the venue is required. Build the self-contained exe
(no .NET install needed on the rig):

```bash
cd apps/rig-agent/OasisRigAgent
dotnet publish -c Release -r win-x64 --self-contained -p:PublishSingleFile=true
```

Configure per rig with `agent.config.json` beside the exe (or `OASIS_*` env
vars, which override the file):

```json
{
  "backendBaseUrl": "https://<your-vercel-domain>",
  "rigToken": "<this rig's secret bearer token>",
  "rigNumber": 1,
  "simulateTelemetry": false
}
```

- `backendBaseUrl` must be `https://` (the agent rejects non-HTTPS except
  localhost, since the token rides on every request).
- Each rig gets its own `rigToken`; the backend scopes the agent to that rig.
- Auto-start on login via Windows Task Scheduler is the simplest option; a
  Windows Service is sturdier if you want it.

Lap detection itself is still stubbed pending the off-site safety gate, supervised
canary, and iRacing spike — until then run
with `simulateTelemetry: true` to exercise the full path, or leave it off and
the agent handles heartbeat + assignment display + the durable outbox.

---

## 4. Before real customers

- **Rotate every demo credential.** The seed (`db/seed.sql`) ships known demo
  values — rig bearer tokens, the staff login, and demo driver PINs. Replace all
  of them before the site is public; see the seed for the exact values to rotate.
- **Clear demo data** if prod shares the seeded database — otherwise the demo
  drivers show up on the live leaderboard.
- **Point the TV** at `https://<your-vercel-domain>/tv` in a kiosk browser.

---

## Quick reference

| Piece | Where | Key setting |
|---|---|---|
| Web app | Vercel | Root Directory `apps/web`; env `DATABASE_URL` + `SESSION_SECRET` |
| Database | Neon | pooled connection string; migrate before first deploy |
| Rig agent | each sim PC | `backendBaseUrl` = Vercel domain; per-rig `rigToken` |
| TV board | venue display | browser at `/tv`, kiosk mode |
