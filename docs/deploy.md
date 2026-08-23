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

The agent runs on every simulator and ships laps outbound to the Vercel app -
no inbound connectivity to the venue is required. Build the self-contained exe
(no .NET install needed on the rig):

```bash
cd apps/rig-agent/OasisRigAgent
dotnet publish -c Release -r win-x64 --self-contained -p:PublishSingleFile=true
```

### Where a rig's token comes from

Every machine needs its own bearer token, and `/staff` is the only place one is
issued. Under **Enrolment**, *Add a rig* gives the rig a number, mints its token
and its QR slug, and prints the whole install command ready to paste:

```
powershell -ExecutionPolicy Bypass -File .\Install-RigAgent.ps1 `
  -RigNumber 4 `
  -RigToken 'oasisrig_...' `
  -BackendBaseUrl 'https://<your-vercel-domain>'
```

Two things follow from how the token is stored:

- **It is shown once.** Only its hash is kept, so nobody - staff, this document,
  or a database dump - can read it back. Copy the command before dismissing it.
  A lost token is not a disaster: pick the rig under *Re-issue a token* and press
  **New token**.
- **Never reuse one.** *New token* is also how a leaked token is revoked: the old
  one stops being accepted the moment it is pressed, and that machine reads
  `⛔ TOKEN REFUSED` until it is re-enrolled with the new one. Laps it already
  recorded are held, not lost, and deliver themselves once it is right. Two
  computers sharing a token is the failure described in "Two computers on one
  rig's token" below.

The QR slug is minted with the rig and printed under the command as a full URL -
that is what the customer scans, and it survives a token rotation, so re-issuing
a token never means reprinting a QR code.

### Installing at the machine

Copy `bin/Release/net8.0/win-x64/publish/` onto a USB stick and drop
`apps/rig-agent/deploy/Install-RigAgent.ps1` into that same folder. Then, at each
rig, signed in as the account that runs iRacing, in an **administrator**
PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File E:\publish\Install-RigAgent.ps1 `
  -RigNumber 3 -RigToken '<this rig's token>' `
  -BackendBaseUrl 'https://<your-vercel-domain>'
```

That is the whole install for one machine. It copies the build to `C:\Program
Files\Oasis Race Control\`, writes this rig's identity, registers the logon task,
starts the agent, and then checks its own work - it reads the build back off the
installed executable, confirms the agent it started is still running, and runs the
identity against the backend and then the simulator. It prints what it did and
what to do next.

Every run after the first one is an update and takes no arguments at all:

```powershell
powershell -ExecutionPolicy Bypass -File E:\publish\Install-RigAgent.ps1
```

It refuses rather than guessing when the command does not describe exactly one rig.
The exit codes are `0` done, `2` the command did not describe one rig, `3` the
source folder is not an agent build, `4` the install failed on this machine, `5`
installed but the result could not be verified, `6` installed and running, but
this rig will not score as it stands, and `7` installed and running, but the
backend refused this rig's token.

The steps below describe what it does and why, and are what to read when something
about a machine is wrong. The installer is not a shortcut around them - three of
them are venue failures it exists to make unreachable, and each says so where it
is described.

### Where the agent keeps its files

The app folder holds the program. Everything the agent writes lives under
`C:\ProgramData\OasisRaceControl\`, which is per machine rather than per user,
so the rig's lap queue is the same one whichever account is signed in:

| | Path | Notes |
|---|---|---|
| Program | `C:\Program Files\Oasis Race Control\` | read-only to the rig account, as it should be |
| Config | `agent.config.json` | looked for beside the exe first, then in `ProgramData` |
| Lap outbox | `C:\ProgramData\OasisRaceControl\outbox.db` | queued laps; survives restarts and outages |
| Log | `C:\ProgramData\OasisRaceControl\logs\agent.log` | rotates at 2 MB, keeps 5; first thing to read on a rig that stopped scoring |
| Instance lock | `C:\ProgramData\OasisRaceControl\agent.lock` | one agent per rig; a second copy exits with code 2 |

`OASIS_DATA_DIR` moves the whole writable side, which is what lets a bench
machine run two agents side by side for testing.

The agent prints (and logs) which config file it actually read at every start.
With two candidate locations, an operator editing the one the agent is not
reading is the failure to expect, and that line settles it.

### Per-rig configuration

Write `agent.config.json` at install time - beside the exe if the installer runs
elevated, otherwise in `C:\ProgramData\OasisRaceControl\` so a token can be
changed later without administrator rights. `OASIS_*` env vars override the file.

```json
{
  "backendBaseUrl": "https://<your-vercel-domain>",
  "rigToken": "<this rig's secret bearer token>",
  "rigNumber": 1,
  "simulateTelemetry": false,
  "idleTimeoutSeconds": 600,
  "idleWarningSeconds": 60
}
```

- `backendBaseUrl` must be `https://` (the agent rejects non-HTTPS except
  localhost, since the token rides on every request).
- Each rig gets its own `rigToken` and its own `rigNumber`; the backend scopes
  the agent to that rig. Two rigs sharing a token used to be the one config
  mistake that produced a wrong leaderboard rather than an error - it is now
  caught and reported instead; see "Two computers on one rig's token" below.
  Write the config per machine rather than copying one rig's folder to the next,
  and the situation never arises.
- There is no version field. The rig reports the build it is running, because
  this file is deliberately left alone by an update and a number typed here would
  be frozen at whatever was installed first. See "Updating the agent on the
  fleet" below.
- Leave `simulateTelemetry` off. On it, the rig publishes invented lap times to
  the live leaderboard; it exists for exercising the backend from a machine with
  no simulator.
- `idleTimeoutSeconds` is how long iRacing may stay closed with a customer still
  checked in before the rig signs them out; the last `idleWarningSeconds` of that
  are spent saying so on the rig's own screen. Tune the period during the pilot
  and set `idleTimeoutSeconds` to `0` on a rig that should only ever be cleared
  from the staff dashboard. See "A customer who walks away" below.

### Starting it automatically

**It has to start in the session the rig signs in to.** `Install-RigAgent.ps1`
registers a logon task for the account it was run as, then reads the task back and
refuses the install unless Windows confirms it is an *interactive* logon task. By
hand it is:

```powershell
schtasks /create /tn "Oasis Rig Agent" /sc onlogon /rl highest ^
  /tr "'C:\Program Files\Oasis Race Control\OasisRigAgent.exe'"
```

That is not one of two equally good options. iRacing publishes its telemetry
under a name Windows scopes to a single sign-in session, so an agent running in
any other session cannot open it - the name simply is not there. Both of the
usual ways to make something "always run" put it in the wrong one:

- a **Windows Service**, and
- a scheduled task set to **run whether the user is logged on or not**.

Either of those runs in session 0, where the agent gets the same "nothing to
attach to" it gets between customers. The rig then heartbeats all night, shows
online, and scores nothing - and because the install is written down once and
followed twenty-plus times, it is the whole room rather than one machine.

The agent says so rather than sitting there looking idle: `/staff` shows the rig
red with `⚠ NOT SCORING`, `logs\agent.log` carries the full explanation, and
`--check-sim` exits 5. If you see any of those, this is the first thing to check.

Scheduled tasks start in `C:\Windows\System32` unless told otherwise. That does
not move anything - the agent resolves its own folders absolutely - but it is
worth knowing when reading a task definition.

Run the agent as the **same Windows user that runs iRacing**, for the same
reason: another account in the same session may be refused the sim's memory
outright, which the agent reports the same way. The installer registers the task
for whichever account it is run as, so run it signed in at the rig; `-RigUser`
overrides that, and it refuses `SYSTEM` and the service accounts by name.

The agent runs with no console either way, which is why it writes its own log -
nothing it prints reaches a person otherwise.

### Keeping a rig's clock right

Every lap carries the moment it was driven, and that one timestamp decides both
which check-in owns the lap and which night it counts for. A machine whose clock
is minutes or hours out therefore loses laps outright (stamped before its driver
checked in, refused for good) or files an evening lap on tomorrow, where tonight's
leaderboard and the TV board will not show it. The rig looks perfectly healthy
either way.

The agent measures its own clock against the backend on every call it makes and
stamps laps through the difference, so those laps still land correctly. It also
says so, in both places an operator looks:

- on the rig's own line - `⚠ CLOCK 3m 0s behind the venue's`; and
- once in `logs\agent.log` each time the reading changes.

That line means *this computer's time is wrong*, not *laps are being lost*. Fix
the machine anyway - the rig's own logs and file timestamps are still wrong, and
the correction only applies while the agent can reach the backend:

```powershell
w32tm /resync /force
```

A rig wrong by **months** rather than hours cannot connect at all: HTTPS rejects
the backend's certificate as not yet valid or long expired by that machine's
clock, so it shows as offline on `/staff` with no laps at all. That is the shape
to expect from a rig with a dead CMOS battery, and the fix is the same plus a new
battery.

### Checking a rig reads the simulator

Run this on the rig, with iRacing open and in a session, before it takes
customers - and again after any iRacing update:

```powershell
"C:\Program Files\Oasis Race Control\OasisRigAgent.exe" --check-sim
```

It reads only the simulator, needs no config or network, takes no lock, and is
safe to run on a rig with the agent already running (which is the normal state -
it starts with Windows). Its first line is the Windows session it read from,
which is what separates "start iRacing" from "this agent is installed wrong".
It answers in seconds:

| Exit | Means | Do |
|---|---|---|
| 0 | Every channel a lap's validity is judged on is readable. | Nothing. This rig will score. |
| 3 | The sim is running but does not publish something the lap rules need. The output names each one and what it costs. | Stop - this rig will not score. The names go to whoever maintains the agent; an iRacing update that renames a channel affects every rig at once. |
| 4 | No telemetry found. | Start iRacing and get into a session, then run it again. |
| 5 | This agent cannot see the simulator from where Windows is running it. | Do not start iRacing again - it will not help. The agent is running as a service, as a "run whether the user is logged on or not" task, or as the wrong user. See "Starting it automatically" above. |
| 6 | iRacing is running and this agent cannot read the telemetry it publishes at all - usually because an iRacing build changed the format. | Nothing at this rig fixes it, and every rig on that iRacing build is in the same state. The output names both format versions; that goes to whoever maintains the agent. See "An iRacing update the agent has not caught up with" below. |

Why this exists rather than "watch the leaderboard": the agent asks the sim for
channels **by name**, and a name that is not there reads as nothing rather than
as an error. Without this check, a rig missing the lap counter scores nothing
all night while showing online with the sim running, and a rig missing the pit
channel is worse - it publishes in-laps through the pit lane as real times.
Neither looks wrong from any screen the venue has.

The running agent applies the same check on every attach: it writes the result
to its log, and if a lap could not be judged clean it withholds laps rather than
publishing unjudged ones, showing `⚠ NOT SCORING` with the channel names.

### Checking a rig's token is the one it was given

Run this on the rig at enrolment, and any time a machine is on the network and
absent from `/staff`:

```powershell
"C:\Program Files\Oasis Race Control\OasisRigAgent.exe" --check-backend
```

It makes one authenticated read against the backend in this machine's config,
takes no lock, touches no lap, and is safe to run on a rig with the agent already
running. `Install-RigAgent.ps1` runs it for you at the end of every install, so
you only reach for it by hand when checking a machine somebody else set up.

| Exit | Means | Do |
|---|---|---|
| 0 | The backend recognises this rig. | Nothing. Its laps will be scored. |
| 1 | There is no config to check. | This machine is not enrolled - run `Install-RigAgent.ps1` with `-RigNumber -RigToken -BackendBaseUrl`. |
| 7 | The backend could not be reached from here. | The token has **not** been judged either way. Get the machine on the venue network and run it again. |
| 8 | The backend answered and refused this rig's token. | Re-enrol with the token this rig was given. No amount of waiting fixes it. |
| 9 | The token works, and it belongs to a **different rig**. | This is another machine's install command, run here. Re-run it with THIS rig's number and token. |

Why this exists: a rig's token is the only part of an install typed by hand and
never read back, and a mistyped character produces a machine that copies, starts,
reports the right build, reads its simulator, shows a customer's name, and then
queues every lap of the night into its own outbox. It is **absent** from `/staff`
rather than wrong on it - a rig that cannot authenticate cannot heartbeat, and
every rig card is built from heartbeats, so it reads as `AGENT OFFLINE / no agent`,
the same as a machine nobody has installed the agent on.

The rig itself is the only place that can say so, and it does: its status line
reads `⛔ TOKEN REFUSED` with the reason, and `logs\agent.log` carries the whole
explanation once. Nothing is lost while it lasts - every queued lap delivers itself
as soon as the token is right.

### An iRacing update the agent has not caught up with

The check above is about channel *names*. One step before it is the telemetry
*format*: iRacing stamps a layout version on what it publishes, and the agent
reads one version. It refuses anything else rather than guessing, because a
reading taken from a layout it does not know is still a plausible-looking lap
time - a wrong leaderboard rather than a missing one.

This is the update failure worth planning for, because it does not arrive one
rig at a time. iRacing updates are forced and the whole venue takes the same one
within a day, so every machine stops scoring together, and no amount of looking
at any single rig explains it. So the agent says it in the same three places as
everything else: `/staff` shows every rig red with `⚠ NOT SCORING` and names
both versions, `logs\agent.log` carries the full explanation once (not once per
retry), and `--check-sim` exits **6** immediately rather than spending its
patience.

The fix is a new agent build on the fleet - nothing at the rig. Run `--check-sim`
on one machine after any iRacing update and the answer takes seconds.

**You do not have to visit each rig to find out.** Every rig reports what it can
do with its simulator on its heartbeat, so `/staff` shows the whole room at once:
a rig that cannot score gets a red card and `⚠ NOT SCORING` above the channels it
is missing. Use `--check-sim` at the machine when you want the full per-channel
list; use `/staff` to find out which machines to walk to.

### Updating the agent on the fleet

There is no auto-update. A new agent build is copied to each rig, and the trigger
is usually not optional - an iRacing update that changes the telemetry layout
stops every machine scoring on the same day (above), and only a new build fixes
it. So this is a walk round twenty-plus computers, and the thing that goes wrong
is losing track of which ones are done.

Put the new `publish\` folder on the stick with `Install-RigAgent.ps1` in it, and
at each rig, signed in as the rig account, in an administrator PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File E:\publish\Install-RigAgent.ps1
```

No arguments. The machine is already a rig, so the installer stops the running
agent, replaces the build (removing anything the previous one left behind),
re-registers the logon task, starts it again, reads the build back off the
executable it just copied, and confirms the agent is still running before it says
it is done. Anything other than exit `0` means do not walk away from that machine.

It will not take an identity on an update. Passing `-RigNumber` or `-RigToken` to a
machine that already has them is refused, because re-typing a rig's identity during
an update is how two machines end up on one token; to change a rig's identity, edit
`C:\ProgramData\OasisRaceControl\agent.config.json` on the machine itself.

By hand, per rig, it is:

1. Close the agent (`q` in its window, or end the scheduled task).
2. Copy the new `publish\` folder over `C:\Program Files\Oasis Race Control\`.
   **Do not touch `agent.config.json`** - it holds this rig's token and rig
   number, and overwriting it with another machine's copy is the one mistake that
   silently merges two rigs (see "Two computers on one rig's token" below).
3. Start it again and read the build back:

```powershell
"C:\Program Files\Oasis Race Control\OasisRigAgent.exe" --version
```

**`/staff` is how you check the round, not your memory.** Every rig reports the
build it is running on each heartbeat, and the dashboard reads the room off those
reports: the line above the rig cards says `Agent build 0.5.0 — 4 of 22 rigs
still to update` while a round is in progress and `all 22 rigs` when it is done,
and every machine still to walk to is marked `update pending` on its own card.

Nothing has to be told that a release happened - the newest build any rig reports
is the one the rest are measured against, so the count starts working from the
first machine you update. Two consequences worth knowing:

- A machine deliberately left on a **newer** build (a bench PC registered as a
  rig) makes the whole room read as behind. That is true rather than a false
  alarm, but it is why a test build does not belong on a rig's token.
- A rig whose build cannot be read as a number reads `build unknown` and counts
  as still to update, rather than being quietly assumed current.

The version is not configuration and cannot be set in `agent.config.json`; a
config that still carries an `agentVersion` line is ignored and says so once in
the log. Bump `<Version>` in `apps/rig-agent/Directory.Build.props` for any build
that goes to a rig, or two different builds report the same number and the count
above is meaningless.

### Two computers on one rig's token

`Install-RigAgent.ps1` makes this one unreachable: a rig's token only ever comes
from the command line at enrolment, and a source folder carrying
`agent.config.json` is refused outright - which is precisely what a copy of a
working rig's folder looks like. The rest of this section is what happens when the
room was set up without it.

The fastest way to set up twenty-plus rigs is to copy one machine's folder to
the next. Copy `agent.config.json` with it and two simulators are now the same
rig as far as the site is concerned: every lap from both machines is credited to
whoever is checked in on the one rig, so half of tonight's board belongs to the
wrong customer and nothing anywhere says so.

Each agent now says which computer it is on every heartbeat - a stable id kept in
`C:\ProgramData\OasisRaceControl\installation-id`, which is deliberately not in
the program folder, folded together with the machine's own name. When two live
installations claim one rig:

- `/staff` puts a red `⚠ TOKEN SHARED` on that rig's card and names the two
  computers underneath it.
- The backend stops attributing that rig's laps and answers `rig_conflict`
  instead. It cannot tell whose customer drove which lap, and crediting the wrong
  driver is worse than waiting.
- Both machines keep every lap in their own outbox and show
  `⚠ TOKEN SHARED WITH ANOTHER PC` on the status line, with the reason in the log
  once (not once per retry).

**To fix it:** give the second machine its own `rigToken` and `rigNumber` and
restart its agent. Every lap it held goes to the leaderboard by itself within a
few minutes - nothing needs recovering by hand. The one exception is the laps
that machine queued *while* it was on the wrong token: they name the other rig's
check-in, so once it is on its own token those are refused rather than credited.
Times driven during the mistake are the cost of the mistake.

Replacing or re-imaging a rig PC is not this. A machine that has been quiet for
three minutes is not competing with anything, so the new installation takes the
rig over with no warning and no database edit.

### A customer who walks away

Nobody tells this system when a customer's time is up: staff sell it at the desk,
and a walk-in who is finished stands up and goes. Their check-in stays open, their
name stays on the rig, and the next person to sit down almost never scans a
machine that already has a session loaded and a name on the screen - so every lap
they drive is credited to the customer before them, on the phone, the staff
dashboard and the TV board. Nothing errors. The board is simply somebody else's.

Each rig now ends the check-in itself. With iRacing closed and a customer still
checked in, the rig spends the last minute saying
`⚠ STILL DRIVING? SIGNING OUT IN 60s — START iRACING TO STAY CHECKED IN` on its
own screen, then signs them out; `/staff` shows the rig available again and the
check-in is recorded as an automatic sign-out rather than a switch. Restarting
iRacing at any point during the countdown keeps the session.

What it deliberately will **not** do:

- **Sign anybody out on a rig it cannot read.** An agent that cannot see iRacing -
  started in the wrong Windows session, or missing a channel - reports exactly
  what a closed simulator reports. It has no idea whether anyone is driving, so
  the countdown does not run; otherwise one install mistake would sign out every
  customer in the room while all of them were still driving.
- **Sign out a customer who left iRacing running.** That seat looks occupied from
  here. Clear those from `/staff`.
- **Touch the walk-in who checked in during the countdown.** The rig names the
  check-in it judged, and the site closes that one or nothing.

`idleTimeoutSeconds` (default 600) tunes the period per rig, and `0` turns it off
on a rig that should only ever be cleared by staff.

### Checking a rig

- **Is it running?** The rig shows online on `/staff` within 30 seconds. A rig
  that never appears is not authenticating - run `--check-backend` at the machine.
- **Is it actually scoring?** The same rig card on `/staff` says so. `SIM READY`
  means a lap driven now would be scored, `SIM CLOSED` means iRacing is not open
  (the normal state of a free rig), and a red `⚠ NOT SCORING` means the rig is up
  and holding laps back - the line under it names what the sim is not publishing,
  or that it publishes a telemetry format this agent does not read.
  `SIM UNKNOWN` means that rig's agent is too old to say, or has not been heard
  from; it is not a claim that the rig is fine.
- **Did it stop scoring laps?** Read
  `C:\ProgramData\OasisRaceControl\logs\agent.log`. A lap the agent refused
  says why: an out lap, a tow, a reset, a lap it joined partway through.
- **"Already running" on start?** Another copy has the rig. The message names its
  process id.
- **Laps queued and not falling?** The rig cannot reach the backend. Laps are
  safe in the outbox and carry when the connection returns, attributed to the
  driver who drove them. If the rig also says `⛔ TOKEN REFUSED`, waiting will not
  clear it - see the next entry.
- **`⛔ TOKEN REFUSED` on the rig?** The backend is reachable and does not accept
  this machine's `rigToken`, so no lap will ever be delivered from here and nobody
  can be checked in. The rig is **missing** from `/staff` rather than wrong on it -
  it cannot heartbeat, so its card reads `AGENT OFFLINE / no agent`, the same as a
  machine that never had the agent installed. Re-enrol it with the token this rig
  was given (`Install-RigAgent.ps1 -RigNumber <n> -RigToken <token> -BackendBaseUrl
  <url>`); every queued lap delivers itself as soon as it is right. `--check-backend`
  answers the same question without restarting anything - see "Checking a rig's
  token is the one it was given" above. If nobody has the token any more, issue a
  new one from `/staff` → **Enrolment** → *Re-issue a token* and enrol with that.
- **Nobody at all is on the board on league night?** The dashboard says so
  directly, under **League night**: *"Nobody is scoring - N laps tonight are not
  counting"*, naming what the rigs are running and what the round is set to.
  That happens when the round's track or car was typed even one character apart
  from the name iRacing publishes - `Dallara IR18` for `Dallara IR-18`, a layout
  typed in for a track that has none. Nothing has failed: every lap is stored and
  every lap is clean, they are just not on the combo the round is asking for.
  Tap **Use what the rigs are running** and the whole night appears - the round
  keeps its number, and nobody has to redrive anything. If the banner is not
  showing, the round's combo is right and whoever is missing is missing for
  another reason - read the next entry.
- **A customer says they drove and they are not on the board?** Take it seriously
  even when the rig looks perfect, because that is what this looks like: the rig
  scores, the card is green, the log shows the laps going out, and the leaderboard
  does not have them. Check the rig's log for the laps and the times, then check
  the Vercel logs for `LAP LOST - two different laps carry one event id`. If it is
  there, two laps were minted with one identity and the second was dropped as a
  retry - the report names the rig, the identity, the lap already stored and the
  lap that arrived. That is a bug in the agent's identity, not something anybody
  at the venue can fix at the machine; the laps are recoverable from the rig's log
  and can be entered by hand. Agent builds from 0.6.0 stamp each run of lap numbers
  with its own token so this cannot happen; a machine still on an older build is
  the first thing to check. If there is no such report, the laps never reached the
  backend at all - look at the outbox and the entries above.
- **A machine you installed is not on `/staff` at all?** That is what a wrong token
  looks like from the dashboard, and also what an unplugged rig looks like. Run
  `--check-backend` at the machine; exit 8 is the token, exit 7 is the network.
- **A rig says `[outbox] This rig's lap queue ... could not be read`?** The lap
  queue on that computer was damaged - a power cut mid-write, its folder copied
  while the agent was running, a backup tool that restored half of it. The agent
  has already replaced it and the rig is scoring again from that moment; the
  unreadable file is kept beside it as `outbox.damaged-<date>.db`. Two things to
  do. Any lap still waiting in the old queue was **not** delivered, so a customer
  who was mid-stint when that machine last stopped may be missing times - tell
  whoever is on the desk. And have the machine's disk looked at: a lap queue does
  not damage itself, and a rig that reports this more than once is telling you
  about its hardware. Nothing needs deleting or re-enrolling.
- **A rig stops at start with `Lap queue error` (exit 10)?** Different fault, and
  it is not the config file. That computer cannot **write** its lap queue - the
  folder is not one the rig's account owns, the disk is full, or something else is
  holding the file. The agent refuses to run rather than drive all evening with
  nowhere to keep a lap through a network hiccup. Free up space or fix the folder's
  permissions (`C:\ProgramData\OasisRaceControl\`), or point the agent somewhere
  the account owns with `OASIS_DATA_DIR`. Nothing has been thrown away: a queue it
  cannot write is deliberately left exactly where it is.
- **`⛔ WRONG RIG` on the rig?** The token on this computer is a different rig's -
  almost always that rig's install command, pasted at this machine. It is the one
  enrolment mistake where nothing looks broken: the token authenticates, so before
  this was caught, every lap driven here was credited to the other rig and to
  whoever was checked in there, while the customer at this station never saw a
  time. The machine now holds its laps and stops reporting itself as that rig, so
  the rig it was impersonating keeps scoring normally. Re-run
  `Install-RigAgent.ps1` here with **this** rig's number and token; the held laps
  deliver themselves onto the right rig as soon as it is right. If two rigs have
  been enrolled the wrong way round, fix both - the line names the rig each token
  really belongs to.
- **A customer's laps are appearing on somebody else's rig?** Check the number on
  each machine's own screen against the rig their laps landed on, and run
  `--check-backend` at the one that is wrong: exit 9 names both rigs. Agents older
  than this check cannot detect it, so update the machine before trusting a 0.
- **`⚠ NOT SCORING` on the rig?** The line beside it says which of three things
  it is. (1) iRacing is running and this build of it does not publish something a
  lap's validity is judged on - laps are withheld rather than published unjudged,
  the channels are named, and `--check-sim` gives the full list. (2) iRacing
  publishes a telemetry format this agent does not read at all, which names both
  versions and is fixed by updating the agent, not by touching the rig - see "An
  iRacing update the agent has not caught up with" above. Expect (1) or (2) after
  an iRacing update, and expect it on every rig at once. (3) The agent cannot see
  the simulator from the Windows session it was started in, which is an install
  fault and no amount of restarting iRacing fixes it - see "Starting it
  automatically" above.
- **`⚠ CLOCK ...` on the rig?** This computer's time is wrong by that much. Laps
  are already being corrected for it, so nothing is being lost - but fix the
  machine (`w32tm /resync /force`) so its own logs read straight, and see
  "Keeping a rig's clock right" above for the rig that is so far out it cannot
  connect at all.
- **`⚠ TOKEN SHARED WITH ANOTHER PC` on the rig, or `⚠ TOKEN SHARED` on its
  `/staff` card?** Two computers are installed with the same `rigToken`. Laps
  from both are being held, not lost. See "Two computers on one rig's token"
  above - the fix is a config edit and a restart on the second machine.
- **A customer cannot start - "wait a moment and tap again"?** The rig's check-in
  page throttles sign-ups, and that rig has produced several in the last minute.
  The next tap after a moment works; nothing is broken and there is nothing to
  fix at the machine. Worth knowing what it is *not*: until this was keyed on the
  rig, the throttle counted the whole building. Every phone on the guest wifi
  reaches the site from one public address, so on a busy open the eleventh
  customer through the door was refused while the ten before them drove, and the
  message they got ("Something went wrong") sent them to find staff. A customer
  who cannot check in still drives, and every lap of that stint is discarded on
  arrival because no check-in owns it. If a whole group is being turned away
  rather than one person tapping fast, that is not this - check that the rig's
  printed QR code is still the one `/staff` has, because a code the fleet no
  longer recognises falls back to counting the building.
- **"lap(s) rejected" on the rig?** That count is the one that does not clear on
  its own. The backend refused to read those laps, so the agent set them aside
  rather than blocking every lap behind them, and the log line carries the
  backend's own words about why. Expect it after a rig has been updated out of
  step with the site. The laps are still in
  `C:\ProgramData\OasisRaceControl\outbox.db` (the `quarantine` table) if a
  customer's time needs recovering by hand.

---

## 4. Before real customers

- **Rotate every demo credential.** The seed (`db/seed.sql`) ships known demo
  values — rig bearer tokens, the staff login, and demo driver PINs. Replace all
  of them before the site is public; see the seed for the exact values to rotate.
  The three seeded rigs are rotated from `/staff` → **Enrolment** → *Re-issue a
  token*; anything still running on `dev-rig-N-secret` is a rig anybody who has
  read this repository can post laps as.
- **Clear demo data** if prod shares the seeded database — otherwise the demo
  drivers show up on the live leaderboard.
- **Point the TV** at `https://<your-vercel-domain>/tv` in a kiosk browser.

---

## Quick reference

| Piece | Where | Key setting |
|---|---|---|
| Web app | Vercel | Root Directory `apps/web`; env `DATABASE_URL` + `SESSION_SECRET` |
| Database | Neon | pooled connection string; migrate before first deploy |
| Rig agent | each sim PC, `C:\Program Files\Oasis Race Control\` | `backendBaseUrl` = Vercel domain; per-rig `rigToken` + `rigNumber` |
| A rig's token | `/staff` → Enrolment → *Add a rig* / *Re-issue a token* | shown once; only its hash is stored |
| Install / update a rig | `Install-RigAgent.ps1`, run at the machine as the rig account | enrol with `-RigNumber -RigToken -BackendBaseUrl`; update with no arguments |
| Is this rig's token right? | `OasisRigAgent.exe --check-backend`, at the machine | 0 accepted, 7 network, 8 refused, 9 another rig's token - the installer runs it too |
| Rig data | `C:\ProgramData\OasisRaceControl\` | lap outbox, log, instance lock, installation id |
| A damaged lap queue | `C:\ProgramData\OasisRaceControl\outbox.damaged-<date>.db` | the agent replaced it and kept it; the rig is scoring again, the laps still in it are not |
| Nobody on the board on league night | `/staff` → League night banner | the round's combo does not match the sim's own names; tap *Use what the rigs are running* |
| A customer missing from the board | Vercel logs, search `LAP LOST` | two laps minted with one identity; the second was dropped as a retry. Fixed in agent 0.6.0 - check the rig's build |
| Agent build | `OasisRigAgent.exe --version`, and the line above the rig cards on `/staff` | bumped in `apps/rig-agent/Directory.Build.props`, never in a rig's config |
| TV board | venue display | browser at `/tv`, kiosk mode |
