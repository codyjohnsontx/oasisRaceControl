# Oasis Rig Agent

The lightweight app that runs on each simulator. It knows the rig's identity,
shows the current driver, reads completed laps out of iRacing, and reliably
ships them to the backend even across network drops and restarts.

## Status

Built and verified end-to-end against the live backend:

- ✅ Per-rig config + bearer-token auth
- ✅ Heartbeat (rig shows online on the staff dashboard)
- ✅ Current-driver display (polls the assignment)
- ✅ Durable, idempotent lap outbox (SQLite) — survives outages and restarts
- ✅ Capture-time attribution: every queued lap carries the `rigAssignmentId`
  the rig had when the lap was detected, so a lap that waits out an outage is
  still credited to the driver who drove it (agent `0.2` and later; the backend
  stores a lap from an older agent unattributed rather than guessing)
- ✅ Deferred stamp for laps captured before the agent has ever reached the
  backend - a rig PC that reboots during an outage cannot say who is in the
  seat, so those laps are held **unresolved**: durable, but unsendable until the
  first successful assignment poll stamps them. Sending an explicit null there
  would tell the backend the rig was empty and lose a checked-in driver's laps.
  An outbox left behind by a pre-`0.2` build upgrades the same way: nothing in it
  carries a stamp, so its whole backlog is held unresolved until that first poll
- ✅ "Switch driver / sign out" - the stint ends on the rig the moment the
  button is pressed, whether or not the backend can be reached. A press the
  venue link swallowed used to do nothing at all, leaving the departed driver in
  the seat and stamping the next person's laps with them; now the checkout is
  queued durably (it survives a rig reboot) and re-sent on the next successful
  poll. It names the assignment it is ending, so a checkout that lands after the
  next driver has checked in closes the stint it was pressed for and never
  theirs. In the meantime laps on that rig carry no owner and land unclaimed on
  the staff dashboard. Two presses have nothing durable to be delivered from:
  one made by an agent that has never completed an assignment poll, which cannot
  name a stint to close and so has nothing to queue at all, and one whose outbox
  write failed - that retry runs for as long as the agent does, but a restart
  before the link returns would lose it. Both say so on the press instead of
  promising a delivery; the failed write is the one that leaves a retry
  outstanding, so it says it again on the rig's status line until the backend
  accounts for it, while the press that named no stint has nothing to show
  there. Either way a stint the backend still holds open on that rig has to be
  cleared from the staff dashboard
- ✅ A lap the backend **refuses** is quarantined, not retried forever. The
  body is validated whole, so one lap it will not accept 400s the entire batch;
  the agent reads the zod issue paths, which name events by their position in
  the batch, parks exactly those rows in the outbox with the reason the backend
  gave, logs each once, and flushes the rest of the queue. The lap is kept and
  never sent again - the outbox holds the only copy of it there has ever been -
  and it is counted apart from the queued laps on the status line, because it is
  waiting for a person rather than for the link to come back. Before this any
  non-2xx threw, which the agent could not tell from the venue's network being
  down, so it marked the rig offline and re-sent the identical oldest-first
  batch every five seconds: one bad lap held every lap queued behind it for the
  rest of the night. Only a refusal that NAMES events quarantines anything; a
  401 from a rotated rig token, a 429, or a proxy's error page names no lap, so
  those still count as unreachable and everything is retried
- ✅ **Lap detection from iRacing** (`"telemetry": "iracing"`) - reads the
  sim's shared memory on the rig PC and posts each completed lap with the
  track, layout and car exactly as iRacing names them. See
  [iRacing telemetry](#iracing-telemetry) below, including what has and has
  not been verified against the real sim.

The current host is a **console app** (runs on macOS/Linux/Windows, so it can be
tested anywhere; the iRacing source itself only reads on Windows). A tray-icon
+ status-window Windows shell is a later UI pass that wraps the same
`OasisRigAgent.Core`.

## iRacing telemetry

`OasisRigAgent.Core/Iracing/` is the real telemetry source. It opens iRacing's
shared-memory map `Local\IRSDKMemMapFileName` **read-only** and its data-ready
event with `SYNCHRONIZE` only, exactly the way the Phase 1 spike recorder does
(`spike/OasisSpike`), and never writes to the sim. The parser is the spike's,
ported rather than replaced by a package: it is repository-owned, has no
dependencies, treats every header field as untrusted, and already had
synthetic-buffer tests. The candidate libraries (IRSDKSharper, irsdkSharp,
iRacingSdkWrapper) are permissively licensed but bring YAML and reflection
machinery this agent does not need, and none has been run on an Oasis rig
either, so a dependency would have bought nothing the spike had not proven.

**How a lap is detected** (`LapDetector`, pure and unit-tested with hand-built
tick sequences):

- `LapCompleted` going up by one is a crossing of the timing line. Its time is
  `LapLastLapTime` (seconds), which iRacing may publish a few ticks after the
  counter moves, so the detector waits for that channel to change from the
  previous lap's value, or for three seconds of ticks to pass, before it trusts
  it.
- The track, layout and car are `WeekendInfo.TrackDisplayName`,
  `WeekendInfo.TrackConfigName` (null when empty, i.e. a single-layout track)
  and the player's own `CarScreenName` from `DriverInfo.Drivers`, read from the
  session-info YAML with a line scanner (`SessionInfoParser`). **The backend
  matches the featured combo by exact string equality** against these, which
  is why the agent logs them verbatim on every lap and the diagnostic prints
  them with the SQL to copy.
- Incidents are the change in `PlayerCarMyIncidentCount` across the lap. If
  the sim does not publish that channel the lap is posted with no incident
  count and the backend treats it as clean.
- Skipped, with the reason logged: no lap time (`LapLastLapTime` at or below
  zero - an out lap or an invalid lap), a lap that touched the pit lane
  (`OnPitRoad`, which also drops the out lap after a stop), a reset, tow or
  trip to the garage mid-lap (`Lap` going down, `EnterExitReset` changing,
  `PlayerTrackSurface` -1, `IsOnTrack` dropping), a lap during which a replay
  was playing, a counter jump of more than one (missed ticks), a time over
  thirty minutes (the backend's bound), a lap that completes before the
  session info has named a track and car, and a lap still showing the lap time
  that was on screen when the counter last went down (stale).
- `LapCompleted` going DOWN (exit to the garage, reset, tow, session restart)
  is a resync, not a lap and not a jump: the next rise of any size - iRacing
  briefly putting the old count back, seen on a real rig, or the out lap after
  a garage exit or reset, which is never timed - quietly re-baselines with no
  lap line, and the log prints one `lap counter resynced` line. The first
  crossing after a drop is therefore never timed; the one after it is, and the
  stale-time rule above keeps it from re-posting the lap time shown before the
  drop.
- A new session (`SessionNum`, `SessionUniqueID` or `PlayerCarIdx` changing),
  iRacing dropping out of a session, or
  iRacing closing and reopening all re-baseline the detector with no lap
  emitted. iRacing not running is the normal idle state: the source retries
  once a second and the status line says `sim idle`.
- Pause needs nothing: no line is crossed and the lap time is the sim's own.

**What has and has not been verified against real iRacing.** Lap detection
is verified on the owner's rig with the diagnostic below (2026-09-26, test
drive, FIA F4 at COTA Grand Prix): it connected, read the session strings
`"Circuit of the Americas"` / `"Grand Prix"` / `"FIA F4"`, timed each lap, and
exposed the garage-exit counter drop that is now a resync (its tests replay
that log). The other trap sequences in
`OasisRigAgent.Tests/Iracing/LapDetectorTests.cs` - pit lane, tow, replay,
session change - are still written from the SDK's documented behaviour. **A
rig posting laps to the hosted app is not yet verified**; run the diagnostic
on every rig before trusting the wall.

### Diagnostic mode - run this first on a rig PC

```text
OasisRigAgent.exe --diagnose
```

Reads only. Posts nothing, saves nothing, needs no `agent.config.json`. Start
iRacing, join a session, get in the car and drive; it prints:

```text
[19:41:02] iRacing CONNECTED
[19:41:02] SESSION track="Circuit of the Americas" config="Grand Prix" car="FIA F4"
           iRacing ids: TrackName="cota gp" TrackID=218 CarID=137 PlayerCarIdx=0
           featured-combo SQL for the wall (copy exactly):
           insert into featured_combos (combo_date, track_name, track_config, car_name, incident_limit)
           values (venue_today(), 'Circuit of the Americas', 'Grand Prix', 'FIA F4', 0)
           on conflict (combo_date) do update set ...;
[19:44:10] LAP 1  -> would NOT post: iRacing reported no lap time for it (out lap or invalid lap)
[19:46:45] LAP 2  2:32.340  incidents=0  -> would POST  track="Circuit of the Americas" config="Grand Prix" car="FIA F4"
```

If it sits on `iRacing NOT RUNNING or not in a session`, the sim is not
publishing telemetry: check that iRacing is in a session (not the menus) and
that the agent runs as the same Windows user. `shared memory NOT READY: ...`
with a `raw header:` line is normal for a few seconds while a session loads -
iRacing sets the connected bit before it fills in the rest of the header (the
first real rig showed `tickRate=0` at that moment) - and it clears by itself;
the reader never stops on it, it retries every second. If it never clears,
the raw header line is what to send. `HEADER ver=2 status=1 tickRate=60 ...`
is printed once the block is usable. A `WARNING this iRacing build does not
publish: ...` line names channels the detector expected and did not find.
Press Enter to stop.

### Setting the featured combo from what the rig reports

The wall only ranks laps whose strings equal tonight's `featured_combos` row.
Paste the `insert ... on conflict` statement the diagnostic printed into the
database (Neon's SQL editor, or `psql`), replacing `venue_today()` with the
event's date as `'YYYY-MM-DD'` when setting it the night before. The same
strings appear on every lap the running agent queues:

```text
[telemetry 19:46:45] lap 2 2:32.340 incidents=0 queued as track="Circuit of the Americas" config="Grand Prix" car="FIA F4"
```

A lap whose strings differ from the row is stored but marked invalid
(`WRONG_TRACK_CONFIGURATION` / `WRONG_CAR`) and does not rank; fix the row, not
the agent.

## Un-parking a quarantined lap

Quarantine is one-way. The agent parks a lap the backend refused and nothing in
the agent ever un-parks it: no retry, no timer, no restart, no command. Getting
a parked lap moving again is a hand edit of the rig's outbox, and this is how
you do it.

Nothing is lost while it sits there. The lap stays in the outbox with the
reason the backend gave, and the status line counts it apart from the queued
laps (`n lap(s) the backend rejected - kept, not sent`), so the rig tells you
the condition exists rather than reading the way it read while the wedge was
live.

**Know which case you are in before you touch anything.**

- *One lap, or a few.* The backend refused those specific laps and accepted the
  rest. This is the ordinary case: a 36-minute pit-box in-lap past the ingestion
  bound, a payload a build produced wrong. The queue drains, the count stops
  growing, and it can wait until morning.
- *The count climbs and never stops.* Every batch is being refused by name. That
  is a web-side validation **tightening** - a deploy that narrowed what
  `/api/agent/events` accepts, the shape of commit `2adf3cc`, which added the
  `lapTimeMs` bound - now 400s every batch and names every lap in it, so the
  agent parks the night's laps as fast as it flushes them. Fix or roll back the
  backend first. Un-parking before the backend accepts those laps parks them
  again on the next flush.

**Recovery, in order:**

1. Stop the agent on that rig.
2. Open its outbox: `outbox.db`, beside the executable
   (`AppContext.BaseDirectory` - the same folder as `OasisRigAgent.exe` and
   `agent.config.json`).
3. See what is parked and why. `rejected_reason` is the whole story: null means
   the row is still sendable, non-null means it is parked and holds the line the
   backend gave for it.

   ```sql
   select event_id, created_at, rejected_reason from outbox
   where rejected_reason is not null order by created_at asc;
   ```

4. Confirm the backend now accepts what it refused. Read the reason, and check
   the deploy actually changed: a raised bound, a reverted validator, a fixed
   payload. If nothing changed, stop here - the next flush will park these rows
   again with the same reason.
5. Clear the reason on the rows you want back. They become ordinary queued laps
   and go out on the next flush, oldest first.

   ```sql
   -- one lap
   update outbox set rejected_reason = null where event_id = '<event-id>';
   -- everything parked, after a backend fix that covers all of it
   update outbox set rejected_reason = null where rejected_reason is not null;
   ```

6. Start the agent. The parked count drops to zero and the queued count picks
   those laps up. If they are refused again, they park again with the current
   reason, and nothing is lost.

Laps that are genuinely invalid and are never going to be accepted can be left
parked. They cost one row each and keep the record of what the rig captured.

## Projects

```text
OasisRigAgent.Core    # cross-platform: config, queue, backend client, orchestrator, iRacing source
OasisRigAgent         # console host (+ --diagnose)
OasisRigAgent.Tests   # xUnit (queue reliability, client contract, lap detection, session-info parsing)
```

## Configure

Copy `OasisRigAgent/agent.config.sample.json` to `agent.config.json` beside the
executable, or use env vars (which override the file):

| File key | Env var | Meaning |
|---|---|---|
| `backendBaseUrl` | `OASIS_BACKEND_URL` | e.g. `https://oasis-race-control.vercel.app` (must be `https://`; `http://` only for localhost) |
| `rigToken` | `OASIS_RIG_TOKEN` | the rig's secret bearer token |
| `rigNumber` | `OASIS_RIG_NUMBER` | e.g. `1` |
| `telemetry` | `OASIS_TELEMETRY` | `iracing` (read the sim), `simulated` (fake laps, testing only), `none` (heartbeat and driver display only) |
| `rigQrToken` | `OASIS_RIG_QR_TOKEN` | this rig's check-in slug (the `/r/<token>` on its QR code). Set it to run [walk-up mode](#walk-up-mode-the-rig-is-the-check-in); leave it out for the staff console |
| `simulateTelemetry` | `OASIS_SIMULATE=1` | older spelling of `telemetry: "simulated"`; ignored when `telemetry` is set |

Two rigs against the hosted app, tokens rotated on the backend first
(`openssl rand -hex 32` each; store `encode(digest('<token>','sha256'),'hex')`
in `rigs.agent_token_hash`):

```json
{ "backendBaseUrl": "https://oasis-race-control.vercel.app", "rigToken": "<RIG 1 TOKEN>", "rigNumber": 1, "rigQrToken": "demo-rig-1", "telemetry": "iracing" }
```

```json
{ "backendBaseUrl": "https://oasis-race-control.vercel.app", "rigToken": "<RIG 2 TOKEN>", "rigNumber": 2, "rigQrToken": "demo-rig-2", "telemetry": "iracing" }
```

`rigQrToken` is the slug in the rig's `/r/<token>` check-in URL
(`rig_qr_tokens.token`); the seed's are `demo-rig-1` and `demo-rig-2`. If new
slugs were inserted for the event, use those.

## Walk-up mode: the rig is the check-in

With `rigQrToken` set, the console runs the loop the owner asked for: "the
user types their name and then as they make laps it assigns it accordingly.
When they are done, they just exit out the program and then it waits for the
next person."

```text
Type your name and press Enter:
Mike
Driving as Mike.
Laps post automatically. Press Enter when you are done.
[telemetry 20:05:11] lap 2 2:17.217 incidents=0 queued as track="Circuit of the Americas" config="Grand Prix" car="FIA F4"
[Rig 01]  ● online  |  driver: Mike  |  sim running

Thanks Mike, you are signed out.

Type your name and press Enter:
```

How it works, with nothing new on the server: the name is signed in through
the backend's own guest check-in (`POST /api/auth/guest`, then
`POST /api/checkin` with this rig's QR token and the takeover confirmed), the
same two requests the phone page sends, so it runs against the deployed app
as it is. The agent then polls the assignment at once, so the next lap is
stamped with the new stint. Enter signs the driver out through the agent's
existing switch-driver (durable: a sign-out the backend cannot be told about
now is delivered later, and until then this rig's laps carry no owner). Closing
the window (Ctrl+C, the close button, a shutdown) signs out on a best-effort
basis; if that never lands, the next name's check-in takes the seat over and
ends the old stint anyway.

- A name already taken tonight gets the backend's rename ("Mike 47") and the
  console says so. An empty name asks again.
- The backend allows ten sign-ins a minute per network address; the two event
  rigs share one, which is plenty.
- Names are 2 to 24 characters: letters, numbers, spaces and `. _ ' -`.
- A rig whose QR token is not registered says so at the first name and asks
  again; fix `rigQrToken`.

## Run (from source)

```bash
export PATH="$HOME/.dotnet:$PATH"
cd apps/rig-agent
dotnet test                          # unit tests
OASIS_BACKEND_URL=https://oasis-race-control.vercel.app \
OASIS_RIG_TOKEN=dev-rig-1-secret OASIS_RIG_NUMBER=1 OASIS_TELEMETRY=simulated \
  dotnet run --project OasisRigAgent -c Release
```

`s` + Enter switches driver, `q` quits.

## Build the Windows exe

```bash
cd apps/rig-agent/OasisRigAgent
dotnet publish -c Release -r win-x64 --self-contained -p:PublishSingleFile=true
# → bin/Release/net8.0/win-x64/publish/OasisRigAgent.exe  (no .NET install needed on the rig)
```

Copy `OasisRigAgent.exe` and `e_sqlite3.dll` from that folder to the rig PC,
put `agent.config.json` beside them, and run the exe (a command prompt in that
folder, or a shortcut). It must run as the same Windows user that runs iRacing,
because the shared-memory map is per session. Run `OasisRigAgent.exe --diagnose`
first on any new rig.

The project owner lifted the Phase 0 venue-safety gate for this project's
software on Oasis computers on 2026-09-26 ("disregard that rule we are past
that. We need this to run"); its guidance - read-only access to iRacing, no
elevation, no writes to the sim - stays as recommendations this agent follows.
See [docs/venue-safety.md](../../docs/venue-safety.md).

## Verified

Run end-to-end against the live Vercel + Neon backend: the agent connected,
polled and displayed the checked-in driver, queued simulated laps, flushed them
(pending count returned to zero), and the laps appeared on the production
leaderboard. Queue reliability (idempotency, oldest-first, restart survival),
capture-time stamping across a checkout, the deferred stamp across an outage and
restart, the offline switch-driver and its queued checkout, the backend
client's result mapping, the shared-memory parser's bounds checks, the
session-info scanner, and every lap-detection trap listed above are covered by
the xUnit suite (`dotnet test`).

The offline switch-driver was also run against a real `next start` backend on a
throwaway Postgres: with the backend killed mid-session the driver's press left
their assignment open and every following lap credited to them as a valid,
ranking lap; with the fix the same run leaves those laps unclaimed and delivers
the checkout when the backend returns. The departing driver's own laps, driven
before the press, are still credited to them.

The quarantine was run the same way, against `next start` on a throwaway
Postgres. Seeded with a four-lap backlog whose second lap is a 36-minute pit-box
in-lap (iRacing's `LapLastLapTime` includes time parked in the box, so this is a
real lap, not corrupt data), the agent before the fix flapped between online and
offline and held all four laps indefinitely with none stored. After it, the rig
stays online, the bad lap is named once on the console and parked, and the three
good laps land attributed and valid on the leaderboard. Restarting the agent on
that outbox does not re-offer the parked lap; pointing it at the same backend
with a rotated token quarantines nothing and keeps retrying, which is what stops
a bad token from retiring a night's laps.

A lap the backend cannot attribute - nobody was checked in when it was captured,
it was driven outside the window of the assignment it names, or it names an
assignment this rig has never had - comes back as
`accepted_unattributed`: the backend stored it with no driver, so the agent
settles it and the outbox drains. Only laps the backend did **not** store (an
error, or a status this agent is too old to recognise) stay queued, because the
outbox holds the only durable copy. See the event model in `docs/plan.md`.

On macOS the iRacing source runs only as far as it can: the parser and
detector against synthetic shared-memory blocks and tick sequences, and the
whole agent against a local backend with the simulated source. Against the real
sim, lap detection is verified on the owner's rig with the diagnostic above;
posting to the hosted app from a rig is not yet verified.
