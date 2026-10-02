# Deploy runbook

How to put Oasis Race Control in production: the web app on Vercel, the
database on Neon, and a rig agent on each simulator. See
[architecture.md](./architecture.md) for how the pieces talk to each other.

Only the web app is "deployed" in the cloud sense. The agent is installed on
each sim PC, and the TV is just a browser pointed at `/tv` - opened from the
**Shop wall board** link under **TV boards** on `/staff`, so the rig monitor
can see it ([monitoring.md](./monitoring.md#event-mode-and-the-20-minute-update)).

There is also a local Kubernetes environment - `kind`, container images, and
Kustomize manifests - for development and for demonstrating the web tier's
runtime behaviour on a laptop. It does not deploy anything and it is not part
of this runbook: see
[platform/local-kubernetes.md](./platform/local-kubernetes.md).

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
   | `DISCORD_WEBHOOK_URL` | the channel's webhook URL ([monitoring.md](./monitoring.md)) | the rig monitor's alerts. Optional: without it the monitor still evaluates, but logs each message instead of posting it. Production only, so a preview never posts to the venue |
   | `DISCORD_ALERT_USER_ID` | the owner's Discord user id | optional: without it urgent alerts still post, with no @mention |
   | `CRON_SECRET` | long random string | the bearer token `GET /api/monitor/tick` requires. Optional: without it the tick refuses every call, while rig heartbeats still run evaluations |
   | `GEMINI_API_KEY` (and optionally `DIAGNOSIS_PROVIDER`, `DIAGNOSIS_MODEL`, `ANTHROPIC_API_KEY`) | see [monitoring.md](./monitoring.md#ai-diagnosis-and-the-copy-paste-handoff) | the urgent alerts' AI diagnosis and handoff. Optional: without a key, alerts post without them. Production only |
   | `GITHUB_RIG_ALERT_TOKEN` | see [monitoring.md](./monitoring.md#the-rig-alert-github-issue) | files urgent software alerts as `rig-alert` issues. Optional: without it, Discord only. Production only |

   Both are read lazily on the request paths that use them — a missing
   `DATABASE_URL` throws the first time a route touches the database, and a
   missing `SESSION_SECRET` throws the first time a session is signed or read.
   Hit `/api/ready` after deploying to surface a bad `DATABASE_URL`: it runs
   one `select 1` through the pool and answers 503 with a plain-English
   `reason` when the variable is missing or the database does not answer
   within 2s, or 200 - carrying the applied-migration count whenever
   `schema_migrations` can be read. `/api/health` only says the process is up
   and never touches the database, so it stays 200 through a bad
   `DATABASE_URL` by design. A missing `SESSION_SECRET` still surfaces only on
   the first sign-in.
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
dotnet publish -c Release -f net8.0-windows -r win-x64 --self-contained -p:PublishSingleFile=true
```

Configure per rig with `agent.config.json` beside the exe (or `OASIS_*` env
vars, which override the file):

```json
{
  "backendBaseUrl": "https://<your-vercel-domain>",
  "rigToken": "<this rig's secret bearer token>",
  "rigNumber": 1,
  "rigQrToken": "<this rig's /r/<token> slug>",
  "telemetry": "iracing"
}
```

- `rigQrToken` turns on walk-up mode: the rig asks for a name, looks it up
  (`GET /api/auth/name`), then asks a returning driver for their 4-digit PIN
  or has a new one pick a PIN (typed twice), logs them in or registers them
  through the app's own sign-in and check-in, posts their laps, and signs them
  out when they press Log out or close the program. The same name and PIN bring a returning driver back to
  their own row on either rig, both days; five wrong PINs lock the name for 15
  minutes (`apps/rig-agent/README.md`, Walk-up mode). Deploy the web app
  before replacing a rig's exe with 0.7 or later: an older site has no
  `/api/auth/name`, and the rig cannot sign anyone in against it.
  Leave it out to keep the staff console.
- `backendBaseUrl` must be `https://` (the agent rejects non-HTTPS except
  localhost, since the token rides on every request).
- Each rig gets its own `rigToken`; the backend scopes the agent to that rig.
- `telemetry: "iracing"` reads laps from the sim's shared memory on that PC;
  `"simulated"` emits fake laps for testing; `"none"` gives heartbeat and
  driver display only. Run `OasisRigAgent.exe --diagnose` on a new rig first:
  it reads without posting and prints the exact track, layout and car strings
  iRacing uses, which the featured combo must match character for character
  (`apps/rig-agent/README.md`, iRacing telemetry).
- The agent must run in the interactive desktop session of the Windows user
  who runs iRacing: the shared-memory map it reads is session-scoped
  (`Local\`), and in walk-up mode the driver signs in at its window.
  Auto-start it with a Task Scheduler task triggered at that user's logon and
  set to "Run only when user is logged on". Do not install it as a Windows
  Service: a service runs in session 0, where it can neither see iRacing's map
  nor show the sign-in prompt to anyone.

If a rig cannot read the sim, staff can post a driver's lap by hand from any
machine with the rig's token: `npx tsx scripts/manual-lap.ts --token <rig token>
--base https://oasis-race-control.vercel.app --time 2:32.340` in `apps/web`
(usage in the file header). The lap carries today's featured combo as that app
holds it, so set the combo first; the script refuses without one.

---

## 4. Before real customers

- **Rotate every demo credential.** The seed (`db/seed.sql`) ships known demo
  values — rig bearer tokens, the staff login, and demo driver PINs. Replace all
  of them before the site is public; see the seed for the exact values to rotate.
- **Clear demo data** if prod shares the seeded database — otherwise the demo
  drivers show up on the live leaderboard.
- **Point the TV** at the **Shop wall board** link under **TV boards** on
  `https://<your-vercel-domain>/staff`, in a kiosk browser, and bookmark that
  link for the kiosk to reopen (it opens the wall for a year). The bare `/tv`
  shows the same board but never reports to the rig monitor.

---

## Migration order, and the gate that enforces it

**Migrate the database first, then deploy the code.** Every migration in
`db/migrations` is additive, so a database that is *ahead* of the code is
harmless; a database that is *behind* it means the app queries tables that do
not exist and the routes needing them return HTTP 500. Additive is not
automatic, though: because migrate runs first, a migration that adds a
*constraint* also has to tolerate what the previous deployment is still writing.
`0004_unattributed_cause.sql` is the worked example - its check constraint would
have rejected that deployment's ownerless laps, and staying harmless took the
before-insert trigger it ships with.

`npm run db:migrate` applies each file in one transaction, so a lock a migration
takes on a table is held until that whole file commits - and the file's own
header is where its window is recorded. That file is the heaviest so far, and it
is small: on a table of 250,000 laps it holds `laps` for a fraction of a second,
and lap inserts arriving during that window queue and then succeed rather than
failing, none rejected. How long exactly depends on the machine and on how many
rigs are writing, so treat the header's measured range as an envelope. Still,
apply migrations while the rigs are quiet when you can, and always before the
code that needs them.

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

The local Kubernetes overlay is the one place that does apply migrations
automatically, and only because a throwaway `kind` cluster has no human in that
loop and no data to lose: a one-shot `db-migrate` Job runs the same
`scripts/migrate.ts`, and the web pods carry an initContainer that runs *this*
gate in a retry loop and refuses to start until the Job's work is recorded in
`schema_migrations`. That is a development stand-in for the rule above, not a
model of it - nothing in production applies DDL without a person
([platform/local-kubernetes.md](./platform/local-kubernetes.md#migrations-run-before-the-web-pods-do)).

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

### Applying 0005_rig_heartbeats.sql

`0005_rig_heartbeats.sql` stores every rig heartbeat for the rig monitor. It is
additive - one table, one index, one view, nothing existing altered - and the
code that writes to it refuses to deploy until it is there, so apply it to Neon
**before merging** the change that adds it - by design the migration lands
first and the merge second, and the verify in step 4 is what says it is safe
to merge. A heartbeat that reaches the old
deployment in the meantime is unaffected: that code never touches the table.

1. Point at production exactly as in
   [step 2 of the recovery runbook](#2-point-at-production-and-prove-it): the
   Neon pooled URL in `apps/web/.env.local`, then the `export` line from that
   step so `psql` reads the same value.
2. From `apps/web`: `npm run db:check`. Read the target line, then expect
   exactly one missing file, `0005_rig_heartbeats.sql`. Anything more and stop:
   the database is behind by more than this change, which is the recovery
   runbook's job.
3. `npm run db:migrate`. Read the `migrating <host>/<database>` line once more;
   expect `applied 0005_rig_heartbeats.sql` and `skip` for the rest. This is the
   supported path: the runner applies the file and its bookkeeping row in one
   transaction.

   Only if you cannot run it, Neon's SQL Editor works as one explicit
   transaction. Paste this, with the whole of
   `db/migrations/0005_rig_heartbeats.sql` copied in unaltered where marked:

   ```sql
   begin;
   -- the whole of db/migrations/0005_rig_heartbeats.sql, unaltered
   insert into schema_migrations (version) values ('0005_rig_heartbeats.sql');
   commit;
   ```

   If anything in it fails, the transaction aborts and nothing is applied -
   fix the paste and run it again. Without the `insert` the build gate keeps
   refusing to deploy, and a later `db:migrate` fails on the table that is
   already there.
4. Verify, whichever way you applied it. `db/verify/0005_rig_heartbeats.sql`
   fingerprints every definition the migration creates - the table's columns
   with their types, nullability and defaults, both constraints, the index's
   exact key order and the view's definition - against a database built from
   the migration file itself, because the bookkeeping row alone only proves a
   filename. It runs in a read-only transaction and reads only catalogs, so it
   is safe against production at any time, from `psql` or pasted into the SQL
   Editor:

   ```bash
   psql "$DATABASE_URL" -f ../../db/verify/0005_rig_heartbeats.sql
   ```

   Expect seven rows, every one `ok = t`. Any `f` means the database does not
   hold what the file says: stop and compare `actual` with `expected` before
   merging. Then `npm run db:check` should say every migration is applied.
5. After the merge deploys, the first heartbeat from each running rig (within
   30 seconds on today's agent) proves the write path. Same read-only
   transaction:

   ```sql
   begin transaction read only;
   select r.display_name, h.received_at, h.agent_version, h.clock_skew_ms,
          h.payload = '{}'::jsonb as sends_v1
   from v_rig_latest_heartbeat h join rigs r on r.id = h.rig_id
   order by r.rig_number;
   commit;
   -- one row per rig that is on; sends_v1 true until the rig runs rig-agent/0.4-monitor
   ```

### Applying 0006_monitor.sql

`0006_monitor.sql` holds the rig monitor's alert state
([monitoring.md](./monitoring.md)). It is additive - two new tables, one
index, one seed row, nothing existing altered - so apply it to Neon **before
merging** the change that adds it, exactly as 0005 went: the migration lands
first, the verify in step 4 says it is safe, the merge follows. Until the
merge deploys, nothing reads the new tables.

1. Point at production exactly as in
   [step 2 of the recovery runbook](#2-point-at-production-and-prove-it).
2. From `apps/web`: `npm run db:check`. Read the target line, then expect
   exactly one missing file, `0006_monitor.sql`. Anything more and stop.
3. `npm run db:migrate`. Read the `migrating <host>/<database>` line; expect
   `applied 0006_monitor.sql` and `skip` for the rest. The runner applies the
   file and its bookkeeping row in one transaction.

   Only if you cannot run it, paste this into Neon's SQL Editor as one
   explicit transaction, with the whole of `db/migrations/0006_monitor.sql`
   copied in unaltered where marked:

   ```sql
   begin;
   -- the whole of db/migrations/0006_monitor.sql, unaltered
   insert into schema_migrations (version) values ('0006_monitor.sql');
   commit;
   ```

   If anything in it fails, nothing is applied - fix the paste and run it
   again. Without the `insert` the build gate keeps refusing to deploy.
4. Verify, whichever way you applied it. `db/verify/0006_monitor.sql`
   fingerprints both tables' columns, every constraint, the one-open-alert
   index and the seed row against a database built from the migration file.
   It is a **single SELECT with no transaction around it**, because the SQL
   Editor shows only the last statement's result - paste the whole file and
   run it, and the result grid is the answer. It only reads, so it is safe
   against production at any time. Or from `psql`:

   ```bash
   psql "$DATABASE_URL" -f ../../db/verify/0006_monitor.sql
   ```

   Expect twelve rows, every one `ok = t`. Any `f` means the database does
   not hold what the file says: stop and compare `actual` with `expected`. An
   error saying `monitor_state` does not exist means the migration is not
   applied at all. Then `npm run db:check` should say every migration is
   applied.
5. After the merge deploys, the first rig heartbeat runs an evaluation. This
   shows it happened (read-only, one statement):

   ```sql
   select last_evaluated_at, now() - last_evaluated_at as ago from monitor_state;
   -- ago under a minute or two while any rig is on
   ```

   Then set the monitor's variables and the outside clock
   ([monitoring.md](./monitoring.md)).

### Applying 0007_board_heartbeats.sql

`0007_board_heartbeats.sql` stores the heartbeat of each `/tv` page opened
from a staff link, and the event mode the monitor last announced
([monitoring.md](./monitoring.md#event-mode-and-the-20-minute-update)).
It is additive - one new table, one index, two new `monitor_state` columns
with defaults - so apply it to Neon **before merging** the change that adds
it, exactly as 0006 went. It needs 0006 applied first.

1. Point at production exactly as in
   [step 2 of the recovery runbook](#2-point-at-production-and-prove-it).
2. From `apps/web`: `npm run db:check`. Read the target line, then expect
   exactly one missing file, `0007_board_heartbeats.sql`. Anything more and
   stop.
3. `npm run db:migrate`. Read the `migrating <host>/<database>` line; expect
   `applied 0007_board_heartbeats.sql` and `skip` for the rest. The runner
   applies the file and its bookkeeping row in one transaction.

   Only if you cannot run it, paste this into Neon's SQL Editor as one
   explicit transaction, with the whole of
   `db/migrations/0007_board_heartbeats.sql` copied in unaltered where marked:

   ```sql
   begin;
   -- the whole of db/migrations/0007_board_heartbeats.sql, unaltered
   insert into schema_migrations (version) values ('0007_board_heartbeats.sql');
   commit;
   ```

   If anything in it fails, nothing is applied - fix the paste and run it
   again. Without the `insert` the build gate keeps refusing to deploy.
4. Verify, whichever way you applied it. `db/verify/0007_board_heartbeats.sql`
   fingerprints the new table's columns, its constraints and index, and the
   two new `monitor_state` columns against a database built from the
   migration. Like 0006's, it is a **single SELECT with no transaction around
   it** - paste the whole file and the result grid is the answer. Or from
   `psql`:

   ```bash
   psql "$DATABASE_URL" -f ../../db/verify/0007_board_heartbeats.sql
   ```

   Expect seven rows, every one `ok = t`. Any `f` means the database does not
   hold what the file says: stop and compare `actual` with `expected`.
   `db/verify/0006_monitor.sql` still passes after 0007: it fingerprints only
   the `monitor_state` columns 0006 created.
5. After the merge deploys, sign in to `/staff` on the hosted address and open
   the **Shop wall board** link under **TV boards** (the bare `/tv` sends no
   heartbeat, so it would show nothing here). This shows its heartbeat arrived
   (read-only, one statement):

   ```sql
   select mode, host, now() - last_seen_at as ago, feed_ok, closed_at
   from board_heartbeats order by last_seen_at desc limit 5;
   -- ago under 30 seconds while the page is open
   ```

### Applying 0008_race_status.sql

`0008_race_status.sql` holds each rig's latest race status for the league-night
race board ([live-race.md](./live-race.md)). It is additive: one new table
with a foreign key to `rigs`, and nothing existing is altered. Apply it to Neon
**before merging** the change that adds it, as with 0007. Until the merge
deploys, nothing reads or writes the table.

1. Point at production exactly as in
   [step 2 of the recovery runbook](#2-point-at-production-and-prove-it).
2. Precheck. From `apps/web`: `npm run db:check`. Read the target line, then
   expect exactly one missing file, `0008_race_status.sql`. Anything more and
   stop. In the SQL Editor, the same answer reads as one row with every column
   `t` (read-only, one statement):

   ```sql
   select
     exists (select 1 from schema_migrations where version = '0007_board_heartbeats.sql') as has_0007,
     not exists (select 1 from schema_migrations where version = '0008_race_status.sql') as lacks_0008,
     to_regclass('public.rig_race_status') is null as table_absent;
   ```

3. `npm run db:migrate`. Read the `migrating <host>/<database>` line; expect
   `applied 0008_race_status.sql` and `skip` for the rest. The runner applies
   the file and its bookkeeping row in one transaction.

   Only if you cannot run it, paste this into Neon's SQL Editor as one
   explicit transaction, with the whole of `db/migrations/0008_race_status.sql`
   copied in unaltered where marked:

   ```sql
   begin;
   -- the whole of db/migrations/0008_race_status.sql, unaltered
   insert into schema_migrations (version) values ('0008_race_status.sql');
   commit;
   ```

   If anything in it fails, nothing is applied - fix the paste and run it
   again. Without the `insert` the build gate keeps refusing to deploy.
4. Verify, whichever way you applied it. `db/verify/0008_race_status.sql`
   fingerprints the new table's columns, its primary key and its foreign key
   against a database built from the migration. Like 0007's, it is a **single
   SELECT with no transaction around it**. Paste the whole file and the result
   grid is the answer. Or from `psql`:

   ```bash
   psql "$DATABASE_URL" -f ../../db/verify/0008_race_status.sql
   ```

   Expect four rows, every one `ok = t`. Any `f` means the database does not
   hold what the file says: stop and compare `actual` with `expected`.
5. After the merge deploys, the public feed answers from the new table. With
   no rig in a session it is empty:

   ```bash
   curl -s https://<hosted address>/api/race/live
   # {"session":null,"rows":[],"otherRigs":0}
   ```

   A 500 there means the table is missing on the database the deployment
   uses. Once a rig with the race-reporting agent is in a session, its row
   shows within a few seconds (read-only, one statement):

   ```sql
   select r.rig_number, s.session_unique_id, s.session_type, s.position,
          now() - s.received_at as ago
   from rig_race_status s join rigs r on r.id = s.rig_id
   order by r.rig_number;
   -- ago under 3 seconds for every rig in the session
   ```

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
- Everything under it, down to and including the blank line before the next
  `---`. Deliberately a boundary rather than a line number: anything added
  above it in this file moves it, and a number written down here would be
  wrong by then.
- **Not that `---`.** It ends the Migration order section and starts this one.
  Take it as well and the two sections merge, and the ordering rule they
  separate goes with them.

This instruction lives at the end of the procedure rather than in a tracker
because a filed follow-up is a thing nobody runs, while the last step of a
procedure someone is already executing is a thing that actually happens.
Delete this step along with it: once that subsection is gone, step 8 has
nothing left to retire.

---

## Quick reference

| Piece | Where | Key setting |
|---|---|---|
| Web app | Vercel | Root Directory `apps/web`; env `DATABASE_URL` + `SESSION_SECRET` |
| Database | Neon | pooled connection string; migrate before first deploy |
| Migration gate | `npm run build` | fails a **production** build when the database is behind `db/migrations` (a preview only warns); `npm run db:check` runs it alone and names the database it read |
| Rig agent | each sim PC | `backendBaseUrl` = Vercel domain; per-rig `rigToken` |
| TV board | venue display | browser in kiosk mode at the **Shop wall board** link from `/staff` (TV boards) |
| Local Kubernetes | your laptop | `./deploy/local/oasis-kind.sh up` - development and demonstration only, deploys nothing ([platform/local-kubernetes.md](./platform/local-kubernetes.md)) |
