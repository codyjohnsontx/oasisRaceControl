# Deploy runbook

How to put Oasis Race Control in production: the web app on Vercel, the
database on Neon, and a rig agent on each simulator. See
[architecture.md](./architecture.md) for how the pieces talk to each other.

Only the web app is "deployed" in the cloud sense. The agent is installed on
each sim PC, and the TV is just a browser pointed at `/tv`.

> **Site returning 500s right after a deploy?** The database is probably behind
> the code. Go straight to
> [Recovering a database that is behind the code](#recovering-a-database-that-is-behind-the-code).

---

## 1. Database (Neon)

The app expects an already-migrated Postgres. Vercel does **not** run migrations
on deploy, so the database has to be ready first. That order is enforced rather
than remembered: `npm run build` refuses to build production when the database
is behind `db/migrations` - see
[Migration order](#migration-order-and-the-gate-that-enforces-it).

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
   (no `vercel.json` needed). Leaving the Build Command at the default matters
   for a second reason: the default runs the repo's `build` script, which is
   what runs the migration gate. Overriding it to a bare `next build` switches
   the gate off.
3. **Environment Variables:**

   | Key | Value | Notes |
   |---|---|---|
   | `DATABASE_URL` | Neon **pooled** connection string | `-pooler` host, `sslmode=require`. Server-only — never `NEXT_PUBLIC_`. |
   | `SESSION_SECRET` | long random string | signs driver + staff cookies. Generate: `openssl rand -base64 48` |

   Both are read lazily on the request paths that use them — a missing
   `DATABASE_URL` throws the first time a route touches the database, and a
   missing `SESSION_SECRET` throws the first time a session is signed or read.
   Hit the site after deploying (or add a health check) to surface a bad config.
4. **Deploy, then read the top of the build log.** The migration gate runs
   before `next build` and names the database it checked:

   ```
   migration check target: ep-...-pooler.<region>.aws.neon.tech/<database>
   migration check ok: 2 migration(s) in db/migrations, all applied to ep-...
   ```

   Confirm those two lines on the first deploy. If they are missing the gate did
   not run - the Build Command was overridden, or the build could not see
   `db/migrations` - and every way it can be switched off is otherwise
   invisible. A guard nobody has watched work is not yet a guard.
5. Note the assigned domain (e.g. `oasis-race-control.vercel.app`); the agents
   need it in step 3.

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

## Migration order, and the gate that enforces it

**Migrate the database first, then deploy the code.** Every migration in
`db/migrations` is additive, so a database that is *ahead* of the code is
harmless; a database that is *behind* it means the app queries tables that do
not exist and the routes needing them return HTTP 500.

`npm run build` runs `scripts/check-migrations.ts` before `next build`. It
prints which database it is pointed at - host and database name, never the
credentials - reads `schema_migrations`, and compares it with `db/migrations`.

What it does about a database it cannot vouch for depends on where the build is
running, because only one of these builds is what the venue sees:

| Build | Database behind `db/migrations`, unreachable, `DATABASE_URL` unset, or `db/migrations` not visible |
|---|---|
| Vercel **production** (`VERCEL_ENV=production`) | **build fails**, naming what is wrong |
| Vercel preview or development | warning, build proceeds |
| Local, `DATABASE_URL` set | **build fails**, naming what is wrong |
| Local, `DATABASE_URL` unset | skipped - no database is configured, so there is nothing to check |

The rest is the same wherever it runs:

| Situation | Result |
|---|---|
| Every migration applied | build proceeds |
| Database ahead of the checkout | warning only, build proceeds (that is a rollback) |
| `SKIP_MIGRATION_CHECK=1` or `=true` | skipped, loudly |
| `SKIP_MIGRATION_CHECK=` anything else | ignored with a warning; the gate stays on |

A failed production build is the desired outcome: Vercel rejects the deploy and
the previous deployment, which does match the database, keeps serving the
venue.

A preview only warns because a pull request that adds a migration is exactly
the one whose preview has to stay openable. Failing it would block review of
the unrelated code in that change, not just its deploy. Preview is also where
`DATABASE_URL` is most often simply absent: a variable scoped to the Production
environment is not present in any other environment's build.

It is deliberately a *check*, not an auto-migrate. Running `db:migrate` from a
build container would apply DDL to the live venue database unattended, and a
preview build would do it to production. The gate blocks the bad ordering
without ever writing.

`db/migrations` sits outside `apps/web`, which is Vercel's Root Directory, so
the gate depends on **Settings -> General -> Root Directory -> "Include files
outside of the Root Directory in the Build Step"** staying enabled (it is on by
default). If it is ever turned off, a production build fails and says so by
name rather than passing with nothing to compare against.

Two limits worth knowing:

- It compares **filenames**, not content. A migration file edited after the
  database recorded it stays "applied" and gets skipped. Verifying the objects
  themselves (step 5 below) is what catches that.
- It runs at build time. Nothing re-checks after the deploy, so a database
  rolled back later is not detected until something 500s.

Run it on its own any time. It names the database it reached before saying
anything about it, so this is also how you answer "which database am I pointed
at":

```bash
cd apps/web && npm run db:check
```

### The gate blocks production deploys until 0002 is applied

Production is behind by `0002_league_night.sql` today. So the first production
build after this lands **fails the gate**, and no production deploy succeeds
until the runbook below has been run against the Neon database. That is the
design working, and the previous deployment keeps serving throughout - but two
consequences follow:

- This gate does not fix `/league` or `/staff`. Applying the migration does,
  with no redeploy at all.
- An unrelated production hotfix attempted before the migration is applied
  needs `SKIP_MIGRATION_CHECK=1` on that build.

---

## Recovering a database that is behind the code

**Symptom.** Routes that need a migration return HTTP 500 while the rest of the
site is fine. When `0002_league_night.sql` is missing, that is `/league`,
`/league/[roundId]`, `/api/league/season`, `/api/league/rounds/[roundId]`, and
`/staff` once signed in. `/`, `/leaderboards` and `/tv` stay 200, laps keep
ingesting (`/api/agent/events` touches no league table), and the wall quietly
drops its league board and keeps rotating - so the TV looks fine and is not
evidence the database is.

### 1. Confirm it from outside (no credentials needed)

```bash
for p in / /leaderboards /tv /league /api/league/season; do
  printf '%s  %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "https://oasis-race-control.vercel.app$p")" "$p"
done
```

A mixture of 200s and 500s is this problem. Everything 500 is a different one
(bad `DATABASE_URL`, database down). `/staff` answers 307 to `/staff/login`
until you are signed in, so it cannot be probed this way.

### 2. Point at production, and prove it

Put the Neon **pooled** connection string in `apps/web/.env.local` (gitignored,
so the credential never reaches your shell history). `npm run db:check` and
`npm run db:migrate` read that file.

```bash
# apps/web/.env.local
DATABASE_URL=<neon pooled url>
```

The `psql` steps below need the same value in the shell, and `.env.local` alone
does not put it there. Load it from the file rather than pasting it, so it stays
out of your history and cannot disagree with what the npm scripts use:

```bash
cd apps/web
export DATABASE_URL="$(node -e 'process.stdout.write(require("dotenv").parse(require("node:fs").readFileSync(".env.local")).DATABASE_URL ?? "")')"
[ -n "$DATABASE_URL" ] || echo "read nothing from .env.local - fix that before going on"
```

Exporting it also settles the hazard that runs the other way. `dotenv` never
overrides a `DATABASE_URL` that is already exported, so a value left over from
an earlier session silently wins over `.env.local` - while a `grep` of the file
keeps reporting the Neon host, confidently and wrongly. The command above
overwrites whatever was there, so the shell and the file now agree.

Do not verify by grepping. Every command below names the host and database it
is talking to; read that line.

### 3. Read the gap. This writes nothing.

```bash
npm run db:check
```

Its first line is `migration check target: <host>/<database>` - confirm that is
the Neon `-pooler` host and not a local one before believing anything after it.
It then names every migration the database has not applied.

The same thing straight from psql, against the value exported in step 2:

```bash
psql "$DATABASE_URL" -c 'select version, applied_at from schema_migrations order by version'
```

### 4. Apply

```bash
npm run db:migrate
```

It prints `migrating <host>/<database>` before it touches anything - read that
line one more time, since this is the step that writes. Then expect one
`applied` line per missing file and `skip` for the rest. It is safe
on a database holding real laps: each file runs in its own transaction, the run
holds a session advisory lock so two of them cannot interleave, and
`0002_league_night.sql` is additive only (its header says what it creates and
what it leaves alone).

**Do not run `npm run db:seed`.** It inserts the demo staff login, demo rig
bearer tokens and demo driver PINs, all of them published in `db/seed.sql`.

### 5. Verify the bookkeeping, then the schema itself

```bash
npm run db:check      # expect: migration check ok: N migration(s) ... all applied to <host>/<database>
```

That only proves `schema_migrations` agrees with the filenames. Check the
objects exist too - a database that once applied an earlier copy of a migration
keeps its row and gets skipped. Against the same exported connection string:

```bash
psql "$DATABASE_URL" <<'SQL'
select c.relname, c.relkind
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('leagues', 'league_seasons', 'league_rounds', 'v_league_round_laps')
order by 1;
-- expect 4 rows: league_rounds r, league_seasons r, leagues r, v_league_round_laps v

select column_name from information_schema.columns
where table_name = 'league_rounds' and column_name = 'prior_featured_combo';
-- expect 1 row; without it, opening a round fails with 42703 undefined_column
SQL
```

If either query comes up short, **stop**. That is a schema repair, not a
re-run: apply the missing DDL by hand from `db/migrations/0002_league_night.sql`.
The "drop and re-migrate" advice in the migration header and in `CLAUDE.md` is
for local development databases only - never the venue's.

### 6. Verify the site

Re-run step 1; expect 200 everywhere. Sign in and load `/staff`.

**No redeploy is needed.** The running deployment recovers on the next request:
the code was always correct, it was the schema underneath it that was missing.

### 7. Confirm league night actually works

Open a round from `/staff`, check it appears on `/league`, then close it. This
is the path the migration exists for, and it is also the path that rewrites the
day's featured combo and restores it on close.

### 8. Delete the warning this procedure just made false

Last, because it only becomes true once the steps above are done: [Migration
order](#migration-order-and-the-gate-that-enforces-it) still carries a
subsection saying production is behind the code, and it no longer is. Delete
it.

- The heading, verbatim: `### The gate blocks production deploys until 0002 is applied`
- Lines **207-219** of this file: the heading on line 207 through the blank
  line on line 219.
- **Not line 220.** That `---` ends the Migration order section and starts this
  one. Take it as well and the two sections merge, and the ordering rule they
  separate goes with them.

This instruction lives at the end of the procedure rather than in a tracker
because a filed follow-up is a thing nobody runs, while the last step of a
procedure someone is already executing is a thing that actually happens.
Delete this step along with it: once that subsection is gone, step 8 has
nothing left to retire and the line numbers it names stop meaning anything.

---

## Quick reference

| Piece | Where | Key setting |
|---|---|---|
| Web app | Vercel | Root Directory `apps/web`; env `DATABASE_URL` + `SESSION_SECRET` |
| Database | Neon | pooled connection string; migrate before first deploy |
| Migration gate | `npm run build` | fails a **production** build when the database is behind `db/migrations` (a preview only warns); `npm run db:check` runs it alone and names the database it read |
| Rig agent | each sim PC | `backendBaseUrl` = Vercel domain; per-rig `rigToken` |
| TV board | venue display | browser at `/tv`, kiosk mode |
