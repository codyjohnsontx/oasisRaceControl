# Oasis Rig Agent

The lightweight app that runs on each simulator. It knows the rig's identity,
shows the current driver, and reliably ships completed laps to the backend even
across network drops and restarts.

## Status

The whole path from the running simulator to the leaderboard is built:

- ✅ Per-rig config + bearer-token auth
- ✅ Heartbeat (rig shows online on the staff dashboard)
- ✅ Current-driver display (polls the assignment)
- ✅ Durable, idempotent lap outbox (SQLite) — survives outages and restarts,
  and a lap the backend will not take cannot block the laps behind it (see below)
- ✅ "Switch driver / sign out" (ends the assignment)
- ✅ **Reading iRacing** — the shared-memory decoder, the session-metadata
  reader, and the lap rules live in `OasisRigAgent.Core/IRacing/` (see below).
- ✅ **Attaching to the running sim** — `IRacingTelemetrySource` opens the
  mapping read-only, waits on the sim's frame signal, and drives `LapDetector`
  from it. It is what the host selects by default on Windows; other platforms get
  `NullTelemetrySource`, and `simulateTelemetry` still emits fake laps on demand.
- ✅ **Running on a rig unattended** - installed to a folder it may not write
  to, one agent per machine, and a log that outlives the run (see below).
- ✅ **Getting onto a rig** - `deploy/Install-RigAgent.ps1` enrols or updates one
  machine in a single command, and refuses the three install mistakes that take
  the whole room down at once (see below).
- ✅ **Knowing whether a rig's token is the one it was given** - a backend that
  refuses this rig is told apart from a network that dropped, said on the rig
  rather than as `offline`, and answerable on the spot with `--check-backend`,
  which the installer runs before it reports done (see below).
- ✅ **Knowing whether a rig can read its sim** — the channels the lap rules
  depend on are declared, checked against the sim on every attach, and answerable
  on the spot with `--check-sim` (see below). An iRacing build that changes the
  telemetry format is refused rather than guessed at, and says so on every screen
  the venue has (see below).
- ⏳ **Proving it against a real sim** — every rule below is covered by tests, but
  they run against a synthetic sim. The frame layout and channel names have not
  yet been confirmed against a live iRacing install (`docs/spike-findings.md`) —
  `--check-sim` is what confirms them, one rig at a time, in a few seconds.
- ⏳ **Venue authorisation** — nothing runs on an Oasis computer until the
  Phase 0 safety gate, the Phase 1A supervised canary, and the Phase 1B
  telemetry spike are done (`docs/venue-safety.md`, `docs/spike-findings.md`).

The current host is a **console app** (runs on macOS/Linux/Windows, so it can be
tested anywhere). A tray-icon + status-window Windows shell is a later UI pass
that wraps the same `OasisRigAgent.Core`.

## Projects

```text
OasisRigAgent.Core          # cross-platform: config, queue, backend client, orchestrator
OasisRigAgent.Core/IRacing  # reading the sim: frame decoding, session metadata, lap rules
OasisRigAgent               # console host
OasisRigAgent.Tests         # xUnit
deploy                      # Install-RigAgent.ps1: enrol or update one rig, and its Pester rules
```

## Reading iRacing

The sim publishes telemetry into a shared-memory region and raises an event each
time a frame is ready. The agent reads that region and nothing else: it never
writes to it, never registers for the sim's broadcast messages, and takes no
third-party SDK or YAML dependency. That boundary is not a preference — it is what
`docs/venue-safety.md` requires of anything that runs on a computer Oasis depends
on, and CI fails the build if a forbidden dependency reaches the published
executable.

Five pieces, each one testable on its own:

| | What it does |
|---|---|
| `WindowsSimConnectionFactory` | The only code that asks Windows for anything. Opens the telemetry mapping with `Read` rights, its view with `Read` access, and the frame signal with `SYNCHRONIZE` and nothing else. |
| `MappedViewReader` | Copies bytes out of that view for the parser. Every read is copied before it is looked at, into a rented buffer rather than a fresh one, and a read the view could only partly satisfy fails instead of returning a tail of nothing. |
| `IrsdkMemoryParser` | Decodes one frame, whole. Every offset in that region is written by another process while we are reading it, so each one is range-checked before it is followed, anything that does not check out raises `MalformedTelemetryException`, and a frame the sim wrote into mid-read is refused rather than returned (see [A frame is one tick or none](#a-frame-is-one-tick-or-none)). |
| `IrsdkSessionInfo` | Pulls the track, configuration, and the *checked-in driver's* car out of the sim's session metadata. Returns null rather than half-answering, because these are the names customers read on the leaderboard. |
| `LapDetector` | Turns frames into the laps the venue keeps. Pure — no threads, no clock, no I/O — so every venue edge case is reachable from a unit test. |
| `IRacingTelemetrySource` | Joins the four together on a background thread and owns everything about a sim that comes and goes. |

Everything above the connection runs against bytes, so the rules are exercised on
any machine — `FakeSim` in the tests publishes shared memory in iRacing's own
layout and the agent cannot tell the difference.

That convenience had a cost worth knowing about: for a long time it meant the code
a rig actually reads its simulator with was the one part of the agent no test ran.
Both halves are covered now, and they are split by what can run where:

- `MappedViewReaderTests` drives the production reader over a mapping the operating
  system really made, on whatever machine CI is on. A mapped view is not a byte
  array — it is larger than what the sim published into it (Windows rounds it up to
  whole pages), a read running off its end comes back short rather than throwing,
  and the publisher keeps writing into the same pages while the agent reads them.
  `IrsdkParserSteadyStateTests` measures the per-frame allocation budget through it
  too; through a byte array that budget cannot fail.
- `WindowsSimAttachmentTests` performs the attachment itself on a real PC — finding
  the sim by its session-local name, reading a view opened with `Read` rights alone,
  waiting on a signal opened with `SYNCHRONIZE` alone, and letting go of all three
  so a restarted simulator is seen as a new one. It needs no iRacing: what is under
  test is Windows, and iRacing's contribution is a name and some bytes. The Windows
  job sets `OASIS_REQUIRE_WINDOWS_SIM_TESTS=1`, which fails the build if those tests
  were skipped rather than run.

`LapDetector` holds the rules, and they are deliberately conservative:

- Attaching, reconnecting, or any discontinuity leaves the car mid-lap, so it
  takes **two** crossings to get back to judging: the first ends the lap the agent
  joined partway through and is discarded. A lap whose start nobody watched has an
  unknowable incident count and could have been through the pits or off the road
  before the agent arrived, and the venue's rule is clean laps only.
- Out laps, in laps, laps interrupted by a tow or a reset, and laps the driver
  was not driving throughout are dropped rather than sent. The lap event contract
  carries a time and an incident count, not a reason code, so a junk lap has no
  honest representation on the wire. The caller still gets the reason back as a
  `LapOutcome` and can log it.
- A lap's `eventId` is derived from rig + sim session + lap number rather than
  minted, so the same lap resubmitted after a crash or a restart lands on the
  backend's idempotency key instead of double-counting.

`IRacingTelemetrySource` owns what a rig does for ten unattended hours a day:

- **The sim is usually not running.** A rig sits with iRacing closed between
  customers. That is the normal state, not an error, and the agent keeps
  heartbeating throughout.
- **A mapping is resolved by name only when it is opened.** So the agent lets go
  of it the moment no session is live: iRacing starting again publishes into a
  brand new region, and an agent still holding the old one would watch dead memory
  for the rest of the day.
- **A sim that dies leaves its last frame behind.** The bytes stay readable and
  still claim a live session — they just stop moving. A frame counter that has not
  advanced for five seconds is treated as a simulator that stopped, so the rig
  does not report a live session to staff until somebody notices.
- **A frame the sim wrote into mid-read is a race, not a fault.** The agent waits
  for the next one. But a rig that never once gets a clean read is a rig that is
  not scoring, so five seconds of that falls to the same rule as a dead sim: drop
  the connection, say so, and re-open. A mapping that describes itself impossibly
  is separate — two in a row are absorbed, and one that stays that way is dropped
  rather than parsed around.
- **Nothing takes the agent down.** A failure to attach, a bad frame, or a
  subscriber that throws is reported and recovered from. Listeners are called one
  at a time, so a display falling over cannot stop a lap reaching the queue that
  submits it.

### A frame is one tick or none

The sim rewrites its telemetry into a rotation of buffers 60 times a second, so
it comes back around to any one of them within a few frames. Read a frame one
channel at a time and a reader delayed by that much — a garbage collection pause,
or the machine's scheduler favouring the simulator, both ordinary on a rig — comes
away with part of one tick and part of the next.

Nothing downstream can see that. Every value in a stitched frame is a plausible
number, so it reaches the lap rules as a lap the customer never drove: the new lap
counter beside the previous lap's time, or a lap charged with an incident from
after the line. It is the one failure in this whole path that produces a *wrong*
leaderboard rather than a missing one.

So the parser takes the newest buffer, copies it in one read, and keeps it only if
that buffer is still the newest and still on the same tick afterwards. Three
attempts, then it reports no frame and the agent waits 16 milliseconds for the
next one — free, because the channels the lap rules watch hold their values for a
whole lap rather than for one frame.

The first half of that is iRacing's own reader protocol. The second half —
*still the newest* — is not, and is what a stalled reader needs: the sim writes a
buffer's data before it stamps the tick that claims it, so a writer that has come
all the way back around is rewriting bytes under a tick that has not moved. It
cannot get back there without having stamped every other buffer with a higher tick
first, which is the tell.

`IrsdkMemoryParserTests` drives both halves, deterministically and against a real
second thread rotating three buffers underneath the reader.

### What a frame costs

A frame carries neither the sim's channel table nor its session document — both
sit elsewhere in the same region and both are republished only when they change.
Decoding them anyway on every frame cost 104 microseconds and a quarter of a
megabyte of allocation *per frame*: at 60 Hz, most of a percent of a core and 15
megabytes a second of garbage on a machine whose only real job is running the
simulator smoothly. It also fed the problem above, because a collection pause is
exactly what leaves a reader mid-copy while the sim publishes underneath it.

Both are now decoded only when they actually change, and the two are told apart
differently on purpose:

- **The channel table** is read out of shared memory on every frame and compared,
  byte for byte, against the copy the current decode came from. iRacing rewrites
  that table when the customer changes car, and a reader still holding the old one
  would read every channel at an offset that now belongs to something else — with
  every value still a plausible number. Comparing costs a memory copy of a few tens
  of kilobytes; it is decoding several hundred records and three times as many
  strings that was expensive.
- **The session document** follows the sim's own revision number, because it runs
  to hundreds of kilobytes and re-copying it to find out nothing changed is the
  whole cost. `IRacingTelemetrySource` already ignores a payload arriving under a
  revision it has read. The one exception is a document that did not parse: the sim
  writes it in place, so the usual reason is that it was caught half-written, and
  the source asks for a fresh copy (`IrsdkMemoryParser.RefreshSessionInfo`) before
  spending another of its three attempts on it.

A steady-state frame now costs 5.8 microseconds and about 800 bytes.
`IrsdkParserSteadyStateTests` holds that budget and proves the parser still
follows a table the sim rewrites, still re-checks one against a buffer that has
shrunk, and still re-reads a document the reader could not use.

## Will this rig read its sim?

The agent asks iRacing for its channels **by name**, and a name that is not there
does not fail — it decodes to null, and whichever rule reads it quietly stands
down. That is the shape of the failure this fleet is least equipped to notice:

- Without `LapCompleted`, the rig heartbeats all night with the sim running and
  scores nothing, reporting no error because from its own point of view nothing
  went wrong.
- Without `OnPitRoad`, it is worse — it scores an in-lap through the pit lane as
  a real time on the public leaderboard.

Neither is hypothetical across twenty-plus machines: iRacing updates every
season, a rename lands on every rig at once, and these names have not been
confirmed against a live install. So `TelemetryChannels` declares every channel
the rules read, what type it is read as, and what is lost without it, and the
agent checks the sim it just attached to against that list before judging a
frame from it:

| Role | Channels | Missing one means |
|---|---|---|
| Lap timing | `LapCompleted`, `LapLastLapTime` | No lap can be built at all. |
| Lap validity | `OnPitRoad`, `IsInGarage`, `IsOnTrack`, `IsReplayPlaying`, `PlayerTrackSurface`, `PlayerCarMyIncidentCount` | A lap cannot be told clean from junk. |
| Precision only | `Lap`, `SessionNum`, `SessionUniqueID` | Laps stay honest, described less precisely. Warns, keeps scoring. |

A missing **validity** channel withholds laps rather than publishing unjudged
ones. Every rule that keeps junk off the leaderboard is a condition that has to
be *seen*, so a channel that is not there reads exactly like a lap where it never
happened — a pit lap and an incident-laden lap both arrive looking clean. The
venue's rule is clean laps only, so a rig that cannot judge is a rig that does
not score, and it says so: `⚠ NOT SCORING` on the status line with the channel
names — the same two words `/staff` puts on the card — and the full verdict in
the log.

**It reaches the staff dashboard, on every heartbeat.** The heartbeat carries
`simHealth` — `scoring`, `unreadable`, or `no_sim` — plus, when unreadable, the
channel names (`apps/web/src/lib/events.ts`), and `/staff` shows the rig with a
red border and `⚠ NOT SCORING` above what is missing. That is the answer to
"which of the twenty rigs is this", without walking the room.

Two rules keep that line worth believing:

- It is a **live reading**, not a fact about the rig. Every heartbeat replaces
  it, and an agent too old to report it writes `null`, which the dashboard shows
  as `sim unknown`. A verdict that could go stale is worse than none — a stale
  `scoring` is a rig quietly not scoring, and a stale `unreadable` is a trip
  across the room for a fault that is fixed.
- A rig nobody has heard from shows no reading at all. It is already reported as
  offline, and its last verdict is however old that is.

That check runs per attach, not per process, so a rig comes back on its own after
the sim is updated again — nobody restarts twenty-plus agents to find out.

**`--check-sim`** answers the same question on demand, for whoever is standing at
the rig:

```powershell
OasisRigAgent.exe --check-sim
```

It reads only the simulator — no config, no backend, no database, no instance
lock — so it runs on a rig with the agent already going, which is the normal
state. Exit `0` this rig will score, `3` it will not and here is what is missing,
`4` no sim to read, `5` this agent cannot see the sim from where it is running
(below), `6` the sim is running and publishes telemetry this agent cannot decode
at all (below). `docs/deploy.md` has the operator's version.

### A telemetry format this agent was not written for

The channel check above is about *names*. One step before it is the *format*:
iRacing stamps a layout version on its telemetry, and every offset this agent
follows is only meaningful under the version it was written against
(`IrsdkMemoryParser.SupportedLayoutVersion`). A build that changes it moves the
whole header.

So the version is the first thing read from a frame and anything else is refused
outright, before the checks it would have invalidated. Two reasons it is not
parsed around:

- **A layout it guessed at would still produce plausible lap times.** This is the
  same failure class as a torn read — wrong leaderboard, not missing one — and it
  is not worth trading a night of scoring for.
- **The reported reason would otherwise be nonsense.** Reading a moved header
  through the old offsets fails somewhere arbitrary, and "the tick rate is
  outside 1..1000" sends an operator hunting a fault that is not there.

It is also the one telemetry failure that is certain rather than possible, and it
does not arrive one rig at a time: iRacing updates are forced, the venue takes the
same one within a day, and the whole room stops scoring together. `SimDecode` is
the single owner of what to say about it, in the same two lengths as `SimReach`
— a clause for the rig's status line and the `/staff` card, the full explanation
plus the fix for `logs\agent.log` and `--check-sim`, which exits `6` immediately
rather than spending its patience on something waiting cannot change.

The verdict rides the same heartbeat chain as everything above (`simHealth`
`unreadable` plus the reason), so the room reads from one screen. Two details
that are deliberate:

- **It is said once per change, not once per attempt.** The agent drops the
  connection and re-attaches every couple of seconds for as long as this holds,
  and a line repeated 1,800 times an hour buries everything else the rig said.
- **It outlives the reconnect, and iRacing being closed.** Unlike the channel
  report, this is a fact about what the simulator on this machine publishes
  rather than a reading of a live session — dropping it with the connection would
  have the rig reporting a healthy idle machine two seconds later, and the hours
  before the first customer of the evening are the ones worth being told in. Only
  a frame that decodes clears it, and a single unreadable frame never sets it: a
  mapping caught mid-rewrite is an ordinary event with its own answer.

### An agent that cannot see the sim from where Windows started it

iRacing publishes into `Local\IRSDKMemMapFileName`, and `Local\` scopes that name
to one Windows sign-in session. A process in a different session does not get a
permission error — the name is not there at all, so the open fails exactly the way
it fails between customers, and the agent reports an idle rig.

Two ordinary ways of making something "always run" land there: a Windows Service,
and a scheduled task set to *run whether the user is logged on or not*. Both run
in session 0, which no signed-in user's session ever is. A third lands next to it:
running the agent as a different Windows user than iRacing, where the mapping
exists and this account is refused it.

None of the three is a machine-by-machine accident. An install is written down
once and followed twenty-plus times, so the failure arrives on the whole room at
the same moment, looking like a quiet evening.

`SimReach` (`OasisRigAgent.Core/IRacing/SimReach.cs`) is the single owner of that
separation. `WindowsSimConnectionFactory` observes the two conditions — the
session Windows put this process in, and whether the last open was refused — and
`SimReach` turns them into a verdict in two lengths:

- a short **summary** for the rig's status line and the `/staff` card, in the
  same register as the channel verdict beside it; and
- the full **instruction** for `logs\agent.log` and `--check-sim`, where somebody
  fixing the machine will read it, including what to do instead.

Three properties matter more than the detection:

- **It is only ever asked after a failed attach.** A rig reading its sim never
  consults it, so a wrong answer here cannot withhold a customer's lap.
- **It is said once per change, not once per attempt.** The loop retries every
  two seconds for a ten-hour day.
- **It clears itself.** Move the agent into the signed-in session and the rig
  recovers without a restart, which is the only way a fix scales to the fleet.

`.github/workflows/rig-agent.yml` registers the published executable as a SYSTEM
scheduled task and requires exit 5 with the fix named — the venue's mistake, made
on real Windows, on every pull request.

## An off the sim charged nothing for

The venue's rule is clean laps only, and the obvious way to enforce it is the
incident count the sim already keeps. That count is not enough on its own:
iRacing charges no point for a great many trips off the road, and the one it is
most likely to let go is running wide on exit and carrying the speed. So the lap
that reaches the backend is 0x, faster than every clean lap of the night, and
indistinguishable from a lap driven properly.

It is the same shape as a torn read — a leaderboard that is *wrong* rather than
one that is missing something — except that here the customer who drove it can
see it is wrong, and so can everyone behind them.

So the agent watches the surface itself. `LapDetector` accumulates
`PlayerTrackSurface == 0` (irsdk_TrkLoc off-track, not the similarly named
material enum) across the whole lap, because a two-wheel off is over long before
the car reaches the line, and clears it at the line so an off on one lap cannot
follow the driver into the rest of the stint. The lap carries it out as
`LapCompleted.OffTrackSeen`, through the outbox, to the backend as
`offTrackSeen`.

Two rules keep it honest:

- **The agent reports; it does not judge.** The observation stays beside
  `incidentDelta` rather than being folded into it, so the incident count is
  still the sim's own number and `apps/web/src/lib/validity.ts` remains the one
  place that decides whether a lap counts. The backend charges an uncharged off
  as one incident against the limit — `max`, not a sum, so an off the sim *did*
  charge is not paid for twice, and a venue that tolerates one incident is not
  made stricter about the off iRacing let go than the one it punished.
- **The field is optional on the wire, and absent means no off was seen.** Rigs
  are updated one at a time and the outbox outlives an agent version. A required
  field would quarantine every queued lap on every rig at once (see below), and
  reading absent as "unknown, so void" would wipe out the night on every machine
  the update has not reached yet.

The lap is still sent. An off-track lap is stored, marked invalid with reason
`OFF_TRACK`, and shown to the driver on their own phone as "off track" — not
"incident", which is the wording that starts an argument at the desk when the
driver's own screen says 0x.

## A lap the backend will not take

`/api/agent/events` validates a submission as one document, so a single event the
contract cannot parse fails all fifty with a 400 — and that batch is the head of a
durable queue the rig resends every five seconds. Nothing about that resolves on
its own: the rig would stop scoring for the rest of the day, read as offline on
the staff dashboard, and need somebody to drive out and clear a database by hand.
On one machine that is a bad night; across twenty-plus of them it is the failure
nobody notices until the leaderboard is visibly wrong.

So a 400 is never retried. The batch is halved until the offending event is on
its own, which sends every other lap on its way and names the one that has to be
set aside. That event is **quarantined** — moved into a second table in the same
database, keeping its payload and what the backend said about it, capped at the
200 most recent so a rig cannot fill its own disk. The rig's status line and log
both carry the count, because a quarantined lap is the one thing here that means
"this machine needs looking at" rather than "this machine is busy".

Quarantine rather than delete, because a 400 from something in front of the
backend looks identical from the rig, and a lap is a customer's time. The agent's
own lap rules cannot build an unparseable event
(`EveryLapItKeepsSatisfiesTheContractTheBackendValidates`), so what this is really
for is the case the agent cannot police: an outbox written by an older version of
the agent than the one now draining it, which is exactly what a fleet-wide update
produces.

The same rule covers a row this agent can no longer read at all. A torn write
leaves a payload nothing parses, and it sits at the head of the queue — so
`PendingBatch` sets it aside instead of throwing, which would otherwise take down
every flush for the life of the machine.

A 500 or a 401 is not a verdict on a lap. Those still throw, the whole batch stays
queued, and the rig goes offline and retries as before.

## A lap queue this machine can no longer read

The failure above is one lap in a queue that still works. This one is the queue
itself: a rig loses power mid-write, or its folder gets copied while the agent is
running, or a backup tool restores half of it, and SQLite afterwards refuses the
file outright — `file is not a database`, or `btreeInitPage() returns error
code 11` for damage past the first page.

Left alone that was the worst failure shape the agent had. It happened at startup,
before anything, so the agent did not start — which means no heartbeat, and a rig
with no heartbeat has no card on `/staff` to be red. It read as `AGENT OFFLINE /
no agent`, byte for byte what a machine nobody ever installed it on looks like
(the same blind spot as [a refused token](#a-rig-the-backend-will-not-authenticate)).
And restarting the machine is what people try, so the fault reproduced itself
every time, for the rest of that computer's life. The message on the screen said
`Configuration error` and told the operator to create `agent.config.json`, which
was the one file that was fine.

So a lap queue the agent cannot read is **replaced**, not fatal. `EventQueue`
opens the file, creates its tables, and runs `pragma quick_check` — the schema
statement alone only reads page one, so a file whose header survived the power cut
opens happily and fails at a flush hours later with a customer's laps in it. A
file that fails any of that is moved aside as `outbox.damaged-<UTC>.db`, a fresh
queue is opened, and the rig scores from that moment on.

Four properties are the contract:

- **Only an unreadable database is replaced.** A folder the rig's account does not
  own, a disk with nothing left on it, a file something else is holding: those are
  reported as themselves and the agent stops with exit code `10`. Replacing the
  file mends none of them, and a machine that renames its queue aside every night
  and still cannot start has turned one loud failure into a nightly silent one.
- **It is kept, not deleted**, byte for byte, the same posture as a quarantined
  lap. It is the only evidence of what the machine lost, and a disk fault is
  diagnosed from the file rather than from our summary of it. The most recent
  three are kept — nobody visits twenty-plus rigs to clear a folder.
- **The journal goes with it.** A rollback journal or WAL left beside the damaged
  file belongs to it; leaving one behind has SQLite replay a stranger's journal
  into the fresh queue, which is how a recovery makes the second corrupt file.
- **It is said out loud, at `Error`, naming both files.** Whatever was still in
  that queue was never delivered. The line ends by pointing at the machine's disk,
  because a lap queue does not damage itself.

What this costs is the laps still waiting in the file, which is normally none —
the flush loop empties the queue every five seconds. What it buys is every lap
driven at that seat afterwards.

The Windows half is not provable from a unit test on any other platform, so
`.github/workflows/rig-agent.yml` performs it for real: `Microsoft.Data.Sqlite`
pools connections, so the handle left open by the failed open is what blocks the
rename, and on macOS and Linux the rename succeeds regardless and the bug is
invisible.

## A rig the backend will not authenticate

A rig's identity is one secret typed at a command line, once per machine,
twenty-plus times in an evening. Nothing about the rest of the install can catch a
mistyped character: the agent copies, starts, reports the right build, reads its
simulator, shows a customer's name once somebody scans, and stacks every lap of the
night in its own outbox. The venue finds out when a customer says their time never
appeared.

What made it invisible was the word the rig used. Every backend call funnels
through one place, and it produced one answer — `offline`. That answer is honest
about a machine whose network dropped: the connection comes back and the queue
drains. It is the opposite of the truth here. The network is fine, the backend is
answering in milliseconds, and its refusal is permanent — so on a night when one
rig says `offline` and twenty say `online`, the wrong word is the difference
between somebody walking back to that machine and nobody ever doing so.

`BackendReach` (`OasisRigAgent.Core/BackendReach.cs`) is the single owner of that
separation, in the same two lengths and for the same reason as `SimReach` and
`SimDecode`: a clause for the rig's status line, and the whole explanation with the
fix for `logs\agent.log` and `--check-backend`. A 401 or a 403 from any call — the
heartbeat, the driver poll, the lap flush, the sign-out — raises it, so the rig
says the same thing whichever of its timers happened to run first:

```
[Rig 01]  ⛔ TOKEN REFUSED  |  driver: — available —  |  sim running  |  4 lap(s) queued  |  the backend does not accept this rig's token …
```

Three properties are the contract rather than incidental:

- **A dropped network never sets it.** Only a status the backend chose does. If an
  outage also produced this line, twenty rigs behind one flaky venue router would
  all report a token problem and the line would mean nothing.
- **A dropped network never clears it either.** A refused rig on a network that
  comes and goes must not flicker back to the word that reads as "wait for the
  wifi". Only a call the backend accepts clears it, and that is the moment a
  re-enrolment takes effect.
- **Nothing is lost and nothing is set aside.** The refusal is not a verdict on a
  lap, so no batch is halved looking for a bad event and nothing is quarantined.
  Every queued lap delivers itself the moment the token is right.

The staff dashboard cannot report this and never will: a rig that cannot
authenticate cannot heartbeat, and every rig card is built from heartbeats, so
`/staff` shows it as `AGENT OFFLINE / no agent` — byte for byte what a machine with
no agent installed looks like. The rig is the only place that knows.

### `--check-backend`

`OasisRigAgent.exe --check-backend` answers "does this rig's identity work?" on the
spot, in the same shape as `--check-sim`: a few seconds, at the rig, over the same
code path the agent uses, before the config lock so it runs on a machine that
already has the agent up. It makes one authenticated **read** and nothing else, so
running it at a rig with a customer on it cannot heartbeat over a real reading, end
a session, or touch a lap.

| Exit | Means |
| --- | --- |
| 0 | The backend recognises this rig. Its laps will be scored. |
| 1 | No config to check — the machine is not enrolled. |
| 7 | The backend could not be reached. The token has **not** been judged either way. |
| 8 | The backend answered and refused this rig's token. |
| 9 | The token works, and it is another rig's — this is a different machine's install command, run here. |

7 and 8 are deliberately separate. Reporting a token problem for a venue whose
network is down sends somebody round twenty machines retyping secrets that were
right all along; reporting a network problem for a wrong token leaves the machine
exactly as it was. 9 is separate from both for the same kind of reason: nothing is
refused and nothing is unreachable, so anybody sent looking for a mistyped secret
is looking for something that does not exist. `Install-RigAgent.ps1` reads all
four: 8 and 9 stop the install reporting done (with their own exit codes, 7 and 8),
and an unreachable backend does not, because enrolment is often done on a bench
before the venue network is up.

## A computer holding another rig's token

The failure above at least stops everything. This one does not stop anything, and
that is what makes it worse.

A rig's bearer token is its whole identity to the backend: laps arrive, the token
names a rig, and whoever is checked in there is credited. The rig number in
`agent.config.json` never travels — it is what the machine calls itself on its own
screen, in its own log, and nowhere else. So the two can disagree, and one command
does it. Twenty-plus machines are enrolled from twenty-plus per-rig install
commands typed in one evening, and pasting the line meant for the machine next to
this one is a single wrong paste with nothing anywhere to catch it.

That computer then works perfectly. It authenticates, it heartbeats, it polls, it
delivers laps — to the other rig, and to the customer checked in over there. The
customer sitting at *this* one scanned this station's QR code and watches a board
their times never reach. Both nights are wrong, each screen shows the number
somebody typed into it, and nothing in the database looks unusual.

Neither side can see it alone. The backend sees a valid token making valid
requests, and the number the machine calls itself never reaches it. The machine
knows which station it is standing at and cannot see whose token it holds. So the
assignment poll now carries the rig the backend authenticated
(`GET /api/agent/assignment` → `rig: { number, displayName }`), and `RigIdentity`
(`OasisRigAgent.Core/RigIdentity.cs`) is the single owner of the comparison:

```
[Rig 04]  ○ offline  |  driver: — available —  |  sim running  |  ⛔ WRONG RIG - this computer is set up as rig 04 but its token belongs to rig 07 (Rig 07 - corner)
```

Four properties are the contract:

- **It only ever fires on an answer.** A backend that does not report the rig at
  all — one older than this agent, or a fleet mid-deploy — changes nothing, and
  neither does a number that could not be read. This stops a rig scoring, and a
  false accusation across twenty-plus machines would cost more nights than the
  real fault does.
- **The laps are held, not sent.** Delivering them is the damage: they would be
  scored onto the other rig's customer, and nothing afterwards could tell them
  apart from that customer's own laps. They stay in this machine's outbox and
  deliver themselves, onto the right rig, when it is re-enrolled.
- **It stops claiming the rig it is not.** A heartbeat is a claim, and a second
  live installation puts that rig into conflict and holds *its* laps too (see "One
  rig token on two computers"). So the machine that knows it is in the wrong place
  stands down, and the machine that really is rig 07 keeps scoring. It keeps
  polling, which is how it learns the token was fixed.
- **The other rig's customer never reaches this screen, or this machine's queue.**
  Showing their name reads as a working rig; stamping a lap with their check-in is
  worse, because that lap is answered `assignment_mismatch` once this machine is
  re-enrolled — settled and dropped. The customer's time would be lost by the
  repair rather than by the fault.

The heartbeat and the flush **wait** for the first poll's answer rather than
checking a flag, because every loop runs immediately at startup. Both races were
invisible in-process and both showed up on the first run against a real backend:
one heartbeat went out ahead of the answer and put the impersonated rig into
conflict, and the first flush emptied a queue of five held laps onto that rig's
customer — which is the realistic sequence, because the machine is enrolled
wrongly, laps pile up, and somebody reboots it.

`--check-backend` answers the same question at enrolment, before any of it
happens, and exits 9.

## Who a lap belongs to

The venue's core invariant is that every lap is attributed to the correct driver,
exactly once, and never reassigned. The rig is the only thing that knows who was
in the seat, so the lap names its driver at the moment it is driven, not when it
is delivered:

- Every queued lap carries `rigAssignmentId` — the check-in the agent believed
  was open when the lap finished — and that claim is written to the outbox
  alongside the lap, so it survives a restart.
- The backend only ever attributes a lap to an assignment whose window contains
  the lap's own completion time. A lap that waited out a network outage lands on
  the driver who drove it even though the rig has since changed hands, and a lap
  the agent stamped from a stale view of a rig staff had already cleared is
  refused instead of credited to someone who left.
- A lap driven with nobody checked in carries no claim. The backend accepts it
  only if the rig's open check-in started before the lap finished, which covers
  the ten-second gap between checking in and the agent's next poll, and refuses
  it once the next customer has taken the rig.

Because that rule turns on the lap's own timestamp, a refusal is permanent — no
later check-in can come to own it. The agent therefore drops a refused lap from
the outbox instead of retrying it every five seconds until closing time and
holding every lap behind it. A backend `error` (its own insert failing) is the
one result still worth retrying.

## How a lap gets its own time

The sim publishes the lap counter and the lap time as two separate channels, and
**nothing says which of them moves first**. iRacing's own reference describes
`LapLastLapTime` as "Players last lap time" in seconds and says nothing about
when it lands relative to the start/finish line; `docs/spike-findings.md` still
carries it as an open question, and no venue recording has answered it.

Read the time at the line and the answer decides whether the venue's boards are
right:

| The sim publishes... | Reading the time at the line gives |
|---|---|
| both together | each lap its own time |
| counter first, time a few ticks later | **each lap the PREVIOUS lap's time** |

The second column is the whole night wrong, and invisible from every screen the
venue has. The times are plausible, the ordering is plausible, the rigs are
green - but every lap is shifted onto the one before it, and a driver's last lap
is usually their fastest, so **the time they are telling their friends about is
the one that never appears at all**.

So `LapDetector` does not read the time at the line. It reads what the channel
was holding *before* the line, and keeps the lap until the channel moves off it:

* moves on the same frame as the counter → the lap is kept there and then, and
  nothing is delayed;
* moves a few frames later → the lap is kept then, still stamped with the moment
  the driver crossed, because which check-in owns a lap and which night it counts
  for are both read off that;
* never moves within two seconds → the lap is given up on. That is what a timing
  reset looks like from here, and the venue would rather be one lap short than
  carry a lap whose number came off the lap before it.

Everything else about the lap is read *at* the line, not when the time turns up:
the incident count is the movement across the lap, and the off-track and pit
flags are cleared for the lap starting now. An incident taken while the sim was
still publishing the last lap's time belongs to the lap the driver is on.

The one lap this costs is two consecutive laps timed to the same ten-millionth of
a second, which is not something a person drives. Two seconds is far shorter than
the shortest lap the venue keeps, so a lap can never still be waiting when the
next one arrives - and if the counter moves anyway, the waiting lap is dropped
rather than handed the next lap's time.

`spike/OasisSpike` is what will settle the question for real: a `LAP_BOUNDARY`
line now records what the channel held before the line and whether it moved, and
a `LAP_TIME_SETTLED` line records how many frames after the line the time
actually arrived.

## Why two laps never share an identity

Every lap carries an `eventId`, and that id **is** the backend's idempotency key:
a lap arriving under an id already stored is dropped as a retry of the one that
is there. That is exactly right for the case it exists for - a rig that delivered
a lap and lost the answer - and catastrophic for any other case, because a second
lap arriving under a spent id is not reported anywhere. The rig gets a 2xx, the
lap leaves the outbox, `/staff` is green, and the customer is simply not on the
leaderboard.

So the id is built to be unique on this machine by construction:

```
lap-r12-s7-n0-l6-t1787164977292162e6495x2
    │    │  │  │  └── this agent run, and which run of lap numbers it is watching
    │    │  │  └───── lap number
    │    └──┴──────── iRacing's own session id and session number
    └───────────────── rig number
```

Only the last part keeps two laps apart. Everything before it is there so a line
in a log or a row in the database says which machine and which sim session a lap
came from.

The run token turns over whenever a run of lap numbers begins - a fresh attach, a
session change, or the lap counter going backwards. That last one is the common
case at a venue: **a driver who restarts their session starts again at lap 1**,
and without the token every lap of their second run carries the identity of a lap
from their first. The same applies across customers, because iRacing hands a new
session its own numbering and whether its `SessionUniqueID` repeats has never
been established against a live install (`docs/spike-findings.md`). Uniqueness
does not depend on the answer.

Resubmission is the outbox's job, not the id's. A lap already queued keeps the id
it was minted with however many times it is sent, so a retry after an outage or a
crash still deduplicates; and a lap the agent never watched from its start is
never emitted at all, so a restart cannot produce the same lap twice.

The backend keeps a backstop for the day this is got wrong again: a duplicate
whose lap does not match the stored one is logged as `LAP LOST - two different
laps carry one event id`, naming both. The answer on the wire stays `duplicate`,
so a rig not yet updated still settles it rather than retrying it all night.

## When the customer has gone home

The venue has no paid-time signal. Staff sell time at the desk and nobody tells
this system when it runs out, so a customer who walks away without signing out
leaves their name on the rig - and the next walk-in almost never rescans a machine
that already has a session loaded and a name on the screen. Their laps are then
credited to the customer before them everywhere the venue shows a result. Nothing
errors; the board is somebody else's.

`IdleWatch` is the single owner of the rule that decides the seat is empty, and it
counts exactly one thing: **iRacing closed, continuously, with a check-in open**.
At Oasis a session ends by closing the sim, so a rig sitting on the Windows desktop
with somebody still checked in is a customer who has gone. The last minute of the
period is spent saying so on the rig's own line
(`⚠ STILL DRIVING? SIGNING OUT IN 60s`), which is what lets a customer who is still
there restart the sim and keep their session.

Two readings deliberately do **not** count as an empty seat:

- **The simulator is running.** Parked in the garage for ten minutes reading a
  setup screen is somebody in the seat.
- **The agent cannot read the simulator** (a missing channel, or an agent started
  where iRacing's shared memory is invisible to it - see above). It cannot tell
  whether anyone is driving, and that reading arrives on every machine at once,
  from the moment a mis-configured fleet starts. Counting silence as an empty seat
  would sign out every customer in the venue one period after the install, while
  all of them were still driving.

The period is measured from a monotonic reading rather than the machine's clock,
because these are venue PCs whose clocks are already assumed to be wrong (see
below) and a clock correction must never sign a driver out mid-stint.

The sign-out request names the check-in it judged rather than saying "whoever is
here", and the backend closes that one or nothing. The gap between deciding and
asking is small, but the rig is in a room with a queue: a walk-in can scan the QR
code in that moment, and ending "whatever is open" would sign out the customer who
has just sat down. It is recorded as an automatic sign-out (`idle_timeout`), not a
switch, so the desk can tell the two apart afterwards.

`idleTimeoutSeconds` (default 600) tunes the period, and `0` turns the behaviour
off on a rig that should only ever be cleared from `/staff`. A customer who leaves
iRacing *running* still needs clearing there - that seat looks occupied from here.

## When the rig's clock is wrong

A lap carries one timestamp, and the backend decides two separate things with it:
which check-in owns the lap, and which venue night it counts for. Both are judged
against the server's clock. So a rig whose own clock is out produces one of two
failures, and neither of them looks like a failure anywhere:

- **running behind** - laps are stamped before their driver checked in, and the
  backend refuses them as belonging to no check-in. That refusal is final, so the
  agent drops them: the customer's time is gone, and the rig stays online, sim
  readable, queue empty; and
- **running ahead** - an evening lap is stamped past midnight. It is stored,
  attributed to the right driver and marked valid, and then filtered off tonight's
  leaderboard and the TV board because it belongs to tomorrow.

`ServerClock` measures the difference rather than trusting the machine. Every
backend response carries a `Date` header, so every call the agent already makes -
the heartbeat, the driver poll, the lap flush - is a reading, taken at the
midpoint of the round trip so the call's own duration is not charged to the clock.
Laps are stamped through it, which puts them on the right driver and the right
night regardless of what the machine believes the time is.

Three rules keep that from becoming its own problem:

- **A healthy rig is left alone.** Differences under two seconds are the
  whole-second `Date` header and a round trip that is not instant, not a wrong
  clock, so they are reported as no correction at all. Nineteen fine machines
  keep stamping laps with their own clock exactly, and the backend already allows
  five seconds of slack on a check-in window.
- **A slow response is not evidence.** A reading is only as precise as half the
  round trip, so anything over four seconds is discarded and the previous
  correction stands. The next call is at most five seconds away.
- **The machine is still broken.** The correction saves the laps; it does not fix
  the computer, whose own logs and file timestamps are still wrong. So the rig
  says so on its status line (`⚠ CLOCK 3m 0s behind the venue's`) and writes one
  log line when the reading changes - not one per request.

Two limits worth knowing. Laps driven before the agent's first successful backend
call of the session carry the machine's uncorrected clock, because nothing has
been measured yet; in practice that is the second or two after startup, but a rig
that starts during an internet outage and takes customers through it is the case
where it matters. And a machine wrong by *months* rather than hours cannot reach
the backend at all - TLS rejects a certificate that is not yet valid or already
expired by its clock - so that rig shows as offline on the staff dashboard.
Offline is at least visible, which is more than the minutes-to-hours case gave
anyone before this.

## Running on twenty-plus rigs

The agent is installed on every simulator in the venue, and each of those is an
ordinary Windows machine that nobody visits between customers. Three things follow
from that, and `docs/deploy.md` has the operator-facing version:

**The folder it runs from is not one it may write to.** `C:\Program Files\` is
read-only to the account a rig signs in as, so an outbox beside the executable
fails on the machines that matter and works on a developer's - the worst way
round. `AgentPaths` splits the two: the config is read from beside the executable
first (where an installer writes a machine's identity) and falls back to
`C:\ProgramData\OasisRaceControl\`, while everything the agent *writes* - the lap
outbox, the log, the instance lock - always lives in that data folder, which is
per machine rather than per user so the queue is the same one whichever account
is signed in. `OASIS_DATA_DIR` moves it, which is how a bench machine runs two
agents side by side.

**Two copies on one rig is a corruption, not a nuisance.** The agent is set to
start with Windows, so the way there is somebody double-clicking the desktop
shortcut when the window is not where they expected. Both copies would write to
one outbox, both heartbeat, both attach to the simulator, and the rig's display
would start disagreeing with itself about who is checked in. `SingleInstanceLock`
holds an exclusive handle in the data folder and the second copy exits with code
2, naming the process that has the rig. The operating system owns the handle, so
a machine that lost power comes back without a stale lock to clear by hand.

**A rig's token is minted by the backend, not chosen by whoever installs it.**
`/staff` → **Enrolment** is the only place one comes from: *Add a rig* mints a
32-byte token, stores only its sha256, and prints the whole install command with
the token in it. So the token an operator pastes is unguessable, unique to that
machine, and shown exactly once - and a token that leaks is revoked from the same
panel, which is the only thing that stops the machine holding it from posting
laps. `apps/web/src/lib/rig-enrolment.ts` owns that; the agent end of it is
unchanged, because a minted token is an ordinary bearer token.

**One token installed on two computers is a wrong leaderboard, not an error.**
A rig's bearer token is its whole identity to the backend, and the fastest way to
set up twenty-plus machines is to copy one rig's folder to the next. Copy
`agent.config.json` with it and both simulators are the same rig: both heartbeat,
both look healthy, and every lap from either machine is credited to whoever is
checked in on the one rig. `InstallationIdentity` is what makes that visible - a
seed kept in the data folder (never beside the executable, or it would be copied
too) folded together with the machine's own name, so a copied program folder, a
cloned disk image and a plain restart are all told apart. It rides on every
heartbeat, and while two live installations claim one rig the backend answers
`rig_conflict` for that rig's laps rather than guessing whose they are.

`rig_conflict` is deliberately not in `SettledStatuses`: every held lap keeps its
place in the outbox and delivers itself once the second machine has its own
token. The one thing that does not come back is the laps that machine queued
*while* it was on the wrong token - they name the other rig's check-in and are
refused when it moves to its own. A status this agent has never heard of is
treated the same way, which is what makes a new refusal deployable to a fleet
that is updated one rig at a time.

**Which build a rig is running is the venue's update record.** There is no
auto-update, and the update that matters most is not optional: a forced iRacing
build can change the telemetry layout and stop the whole room scoring on the same
day (see "A telemetry format this agent was not written for" above), which is
fixed by copying a new agent onto twenty-plus machines. Halfway through that walk
the only question is which ones are done.

`AgentVersionInfo` answers it from the assembly that is running, and from nowhere
else. It used to be a field in `agent.config.json` - which is exactly the file an
update must *not* overwrite, because it holds the rig's token - so the number the
dashboard showed was frozen at install and no new build could change it. A config
that still carries the line is ignored and says so once at startup;
`--version` prints the same string the rig heartbeats, so the answer is available
standing at the machine as well as from `/staff`, where the line above the rig
cards counts the room against the newest build any rig has reported.

The string is bounded (`AgentVersionInfo.MaxWireLength`) because the heartbeat
contract caps it: an over-long version fails the whole heartbeat, and a rig that
cannot heartbeat reads as offline - a worse answer than a shortened number. The
build itself comes from `apps/rig-agent/Directory.Build.props`, one place for
every project in the agent, so the number in the exe's file properties is the one
the rig reports.

**Getting onto a machine is where the fleet's worst failures come from.** Three of
the ones above - a rig on another machine's token, an agent started where it can
never see the simulator, a rig left behind by an update round - are not driving
mistakes or bugs in the lap rules. They are install mistakes, and an install
runbook is written once and followed twenty-plus times, so every one of them
arrives on the whole room rather than on one machine.

`deploy/Install-RigAgent.ps1` is that runbook as one command, and it is written to
make those three unreachable rather than to save typing:

- A rig's token only ever comes from the command line at enrolment, and a source
  folder carrying `agent.config.json` is refused - which is exactly what a copy of a
  working rig's folder looks like. An update passed an identity is refused too.
- An update copies the build over the top of `agent.config.json` and never writes
  it. Where that file goes is decided when the run is planned (the data folder,
  never beside the executable, so the next build cannot land on it) rather than at
  the moment of writing, so an update cannot drift into rewriting it.
- The logon task is registered for the account the installer was run as, then read
  back from Windows and the install refused unless it is an *interactive* logon
  task. `SYSTEM` and the service accounts are refused by name.

It then checks its own work rather than reporting what it attempted: the build is
read back off the executable it just copied (a copy blocked by a running agent is a
machine that would have been counted as updated), the agent it started has to still
be running a moment later (it exits at once if it cannot read this machine's config,
which would leave a rig showing offline behind a console that said "Done"), and
`--check-sim` decides the exit code. "iRacing is not running" is the ordinary answer
at a rig nobody is sitting at and reads as done; "cannot see the sim from here" and
"a telemetry format this build was not written for" do not.

The rules are tested on any machine (`deploy/Install-RigAgent.Tests.ps1`, Pester 5+:
`pwsh -Command "Invoke-Pester apps/rig-agent/deploy -Output Detailed"`), and so is
the whole command, with the four Windows calls stood in for so the order and the
verdict can be checked anywhere. The parts
that need real Windows - the logon task's principal, stopping a running agent,
asking the installed exe which build it is - are performed for real on every pull
request in `.github/workflows/rig-agent.yml`, which enrols a rig, updates it, and
tries all three refusals.

**Nothing it prints reaches a person.** Started by Task Scheduler there is no
console, so `RotatingFileLog` writes `logs/agent.log` in the data folder: every
line flushed as it is written (the interesting case is the agent that was killed),
timestamped in UTC (so two rigs can be compared), and capped at 2 MB across 5
files (nobody visits twenty-plus machines to clear a log folder). It is the first
thing to read on a rig that stopped scoring laps - a refused lap says which rule
refused it.

## Configure

Copy `OasisRigAgent/agent.config.sample.json` to `agent.config.json` beside the
executable or into the data folder, or use env vars (which override the file).
The agent logs which of the two files it actually read at every start:

| File key | Env var | Meaning |
|---|---|---|
| `backendBaseUrl` | `OASIS_BACKEND_URL` | e.g. `https://oasis-race-control.vercel.app` |
| `rigToken` | `OASIS_RIG_TOKEN` | the rig's secret bearer token |
| `rigNumber` | `OASIS_RIG_NUMBER` | e.g. `1` |
| `simulateTelemetry` | `OASIS_SIMULATE=1` | emit fake laps instead of reading the sim (testing only) |
| `idleTimeoutSeconds` | `OASIS_IDLE_TIMEOUT_SECONDS` | how long iRacing may stay closed with somebody checked in before the rig signs them out (default 600; `0` never does) |
| `idleWarningSeconds` | `OASIS_IDLE_WARNING_SECONDS` | how much of the end of that period the rig spends warning on its own screen (default 60) |
| - | `OASIS_DATA_DIR` | move the outbox, log, and lock somewhere else |

Leaving `simulateTelemetry` off is what makes a rig read the real simulator, so a
venue machine can never quietly publish invented times to the leaderboard.

There is no version key. The agent reports the build it is running (above), and
an `agentVersion` line left over from an older install is ignored rather than
obeyed - with a line in the log saying so, because a config that looks like it
sets the version while the dashboard shows another number is worse than either.

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
leaderboard.

A rig enrolled entirely from the staff dashboard was driven end to end against
the running backend, its leaderboard and its TV board: *Add a rig* on `/staff`
minted Rig 04's token, the published agent answered `--check-backend` exit 0 with
it, a guest scanned the QR slug minted with the rig and checked in, the agent's
status line showed that driver's name, its laps reached `/staff` and the Fastest
Tonight board, and the rig's card read `online / SIM READY`. Pressing *New token*
for the same rig then made the old token exit 8 ("the backend refused this rig's
identity") and the new one exit 0 - the revocation the venue has to be able to
perform.

One rig and two customers were driven end to end against the running backend, its
leaderboard and its TV board, through the real telemetry path (shared memory ->
frame decoder -> lap rules -> outbox -> HTTP). Marcus T drove three clean laps at
Spa, the desk closed his check-in and opened Priya R's on the same seat, and she
restarted the session and drove three of her own. With the identity the agent
shipped before this change, all six laps were delivered and settled and the board
read `Marcus T | 3 laps | 2:18.204` - Priya R was not on it at all, and nothing
anywhere said so. With the run token the same night puts both on `/leaderboards`
and on the `/tv` wall (`01 Marcus T 2:18.204`, `02 Priya R 2:19.880 +1.676`) with
three laps each. Replaying the broken night against the current backend also
produced three `LAP LOST` reports naming the stored and the arriving lap.

A rig enrolled with a mistyped token was driven end to end against the real
backend, the real leaderboard and the real staff dashboard. The published agent
showed `⛔ TOKEN REFUSED` with the reason on its status line, wrote the whole
explanation once to its log, and stacked four laps in its outbox while the
leaderboard stayed empty and `/staff` showed the machine as `AGENT OFFLINE / no
agent` - identical to the two rigs that have never had an agent. `--check-backend`
answered 8 against that token, 0 against the right one, and 7 against a port with
nothing on it. Given the right token the same machine came back `● online` with
the checked-in driver's name, and every queued lap reached the leaderboard.


`dotnet test` covers queue reliability (idempotency, oldest-first, restart
survival), the backend client's result mapping, the frame decoder against both
well-formed and deliberately corrupted shared memory, the session-metadata
reader, the lap rules against the venue's edge cases — an out lap, a spin and a
tow, a session restart, the agent restarting mid-stint, a driver changing combo
without leaving the seat, and someone watching a replay — and the live path
against a synthetic sim: attaching mid-stint, iRacing quitting and starting again,
a simulator that dies with its last frame still in memory, torn reads, session
metadata that cannot be read, and a listener that throws.

A rig whose clock is wrong was driven end to end against the real backend and
the real leaderboard: a venue server three minutes ahead of the machine, a driver
checked in on the server's clock, the published agent stamping laps through the
correction. All five laps were accepted, attributed to the right driver, and the
best of them took the top of the TV board - while the rig showed `⚠ CLOCK 3m 0s
behind the venue's` and said so once in its log. The same lap sent with the
machine's uncorrected timestamp, which is exactly what the previous agent put on
the wire, came back `assignment_mismatch` and was dropped.

A rig whose lap queue was destroyed was driven end to end against the real
backend, the real leaderboard and the real staff dashboard. The published agent
delivered three laps for the checked-in customer, was killed the way a power cut
kills it, and its `outbox.db` had every page past the first overwritten. Restarted,
it named the damage (`Page 4: btreeInitPage() returns error code 11`), kept the
unreadable file as `outbox.damaged-<UTC>.db`, opened a fresh queue, and went back
to scoring: three more laps were delivered for the same customer, and the fastest
lap of the night on the Tonight board - 2:17.425 - was one of them, driven after
the recovery. Its card on `/staff` read `ONLINE / SIM READY` throughout. The same
binary against a lap queue it could not *write* refused instead, exiting 10 with
`Lap queue error`, naming the file and leaving it exactly where it was rather than
saying anything about `agent.config.json`.

The installed layout was run the way a rig runs it: published into a folder
whose write permission was then removed, started with its config only in the data
folder, and left with no console to read from. It came up, put the outbox, the log
and the lock in the data folder, wrote nothing beside itself, and the laps reached
the leaderboard and the wall display. A second copy on the same rig exited with
code 2 naming the first. The agent was then killed outright, the way a power cut
would: the restart took the lock straight back, appended to the same log, and
carried the lap still sitting in the outbox.

An agent update round was driven against the real backend and the staff
dashboard with a room of twenty-two rigs: all of them reporting the build the
venue runs today, then the published agent started on one of them with a config
file still declaring a different version. It reported the build it was running,
said the config line was ignored, and the dashboard turned from `Agent build
0.1-skeleton - all 22 rigs` to `Agent build 0.5.0 - 21 of 22 rigs still to
update`, marking every machine still to walk to. Updating the rest took the count
down to `all 22 rigs`; a machine left behind and one on an unreadable build both
stayed marked.

The installer's rules were driven with counterfactuals rather than only asserted:
thirteen deliberate breakages were each confirmed to turn the suite red - the
source folder allowed to carry a rig's identity, the copy allowed to overwrite
`agent.config.json`, the identity written on every run rather than at enrolment,
the identity written beside the executable where the next build lands on it, the
build copied before the run is validated, the build copied before the running agent
is stopped, the config looked up in the wrong order, the service accounts allowed as
the rig user, plain `http` accepted, stale files from the previous build left behind,
the build the rig reports never compared with the one installed, the agent assumed
to still be running, and an unrecognised simulator-check answer read as success.

The lap queue's recovery was proved the same way. Seven deliberate breakages were
each confirmed to turn the suite red: the damaged queue allowed to stop the agent
(the bug itself), the integrity check dropped so damage past the first page is
found hours later at a flush, a queue the agent merely could not *open* replaced
rather than reported, the damaged file deleted instead of kept, its journal left
beside the fresh queue, the kept copies never pruned, and a healthy queue reported
as damaged. The third of those was a false green first time round - the test used
a path that could not be renamed either, so it passed against code that would have
renamed a real one aside - and it took a movable read-only file to separate
"declined to move it" from "failed to move it".

One of those started green and proved nothing: the test named for "stops the agent
before replacing the file it is running from" was asserting the stop came before the
version was read, which is still true when the copy happens first. It only
discriminated once the stub recorded what was on disk at the moment it stopped.

The venue install itself - the logon task's principal, the running
agent it leaves behind, the build the installed exe reports, the identity surviving
an update, and the three refusals - runs against real Windows on every pull request
rather than here, because a Mac has no task scheduler to be wrong about.

None of it needs iRacing, which is why it runs on every pull request
(`.github/workflows/rig-agent.yml`). That workflow fails the build if a forbidden
dependency reaches the published executable, or if any source file reaches for a
writable mapping or a message that could drive the simulator - and it runs the
published executable on Windows to prove it writes nothing beside itself and
refuses a second copy, that the published exe names the build it is (matching its
own file properties), and that the venue install works when performed for real -
enrolling a rig with the runbook's own command under Windows PowerShell, updating
it, and confirming Windows itself calls the resulting task an interactive logon
task. Those are claims about the venue's machines that no cross-platform test can
settle.
