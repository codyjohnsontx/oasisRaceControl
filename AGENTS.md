# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## The `/tv` board rotation

`/tv` is an unattended wall display that cycles board types on a timer. Adding a
new kind of board (rig status, an event countdown) means writing one
`defineTvBoard` in `apps/web/src/components/tv/board-types.tsx`, registering it in
`TV_BOARD_TYPES`, and emitting its slides from `buildRotation` - do not modify the
rotation engine (`tv-screen.tsx`) or write a second ranking implementation. The
contract and the rules the engine guarantees are documented in
`apps/web/src/lib/tv-rotation.ts`.

Board data comes from the same public APIs `/leaderboards` and `/league` use, so
the wall and the phone agree by construction.

A board can also take the wall over rather than take a turn on it, without any
engine change: renew the contract's `hold()` on every refresh while the takeover
condition holds. The league board does exactly that while tonight's round is
open. Bound any such condition by the venue day - nothing closes a round by
itself, and an unbounded takeover owns the wall until someone notices.

## Verifying `/tv` failure behaviour needs a production build

Test feed outages against `npm run build && npm run start` (from `apps/web`; there
is no root `package.json`), not `npm run dev`.
Next's dev HMR client force-reloads the page when the dev server dies, so the tab
lands on Chrome's own error page and you cannot tell whether the app recovered.
Under `next start` the page stays put and self-heals, which is what the kiosk does.

## League night

- Shop owner's shape for the league: a season IS a calendar month, and a round runs
  every Wednesday - roughly four or five rounds a season, twelve seasons a year.
  So ending a season is a routine monthly job for whoever is on shift, not an admin
  operation: `/staff` rolls it (`rollLeagueSeason` in `apps/web/src/lib/league-queries.ts`),
  and a new season defaults to its venue-local month name (`venueMonthName`).
  Nothing rolls a season on a date boundary by itself - the trigger stays human.
- A round owns laps by time window + combo; laps carry no round id. The rule lives
  in one place, `v_league_round_laps` (`db/migrations/0002_league_night.sql`), and
  every league query joins through it. Change the rule there, nowhere else.
- Two league surfaces, and they read different endpoints. `/league` is the
  full-detail season page customers open on a phone and the wall's league board
  is a `/tv` board type like any other (see the section above); both take season
  standings from `/api/league/season`. The round page `/league/[roundId]` is the
  odd one out - it reads `/api/league/rounds/[roundId]` for one round's ranked
  field and per-driver laps, which the season endpoint does not carry. Neither
  surface wraps the other.
- Season points are one swappable module: `apps/web/src/lib/league-scoring.ts`.
  Nothing else in the codebase encodes a points table. The scale is the venue's
  own and is final: P1-P5 score 5, 4, 3, 2, 1, and every other entrant scores 1.
  Fifth place and the participation point being equal is intended. Season total
  is the sum of every round entered - no drops, no bonus points.
- Opening a round also overwrites the day's `featured_combos` row, so the day and
  the round agree about what is featured; closing it restores whatever was there
  (`league_rounds.prior_featured_combo`, null meaning there was no row). Both
  halves are transactional - see `openLeagueRound` / `closeLeagueRound` in
  `apps/web/src/lib/league-queries.ts`. `repointOpenRound` is the third member of
  that set and moves both together too (see "A combo typed one character off the
  sim's own name", below).
- `league-round-lifecycle.test.ts` runs under plain `npm test` against a scratch
  database it builds from `db/migrations`, so it never touches Neon. How to point
  it, and when it skips versus hard-fails, is in the root README's
  [Integration tests](README.md#integration-tests) section.

## Local dev

- `apps/web/.env.local` is gitignored and its comments have gone stale before.
  Read `DATABASE_URL` itself before assuming which database (local Docker
  `oasis-pg` on 5433, or Neon) a dev server or migration is pointed at.
- A local database that applied an earlier `0002_league_night.sql` reports
  `skip 0002_league_night.sql (already applied)` and then fails to open a round
  with `42703 undefined_column`. Drop and re-migrate it; the migration header
  (`db/migrations/0002_league_night.sql`) explains why.

## Pull request review

CodeRabbit reviews a pull request once, when it opens, and does not re-review as
further commits land - the setting and the reasoning live in `.coderabbit.yaml`
(`reviews.auto_review.auto_incremental_review`).

What asking for a review of the later commits actually does is not settled.
Observed on `codyjohnsontx/DiazOnDemand#9`, where the same config is live: the
automatic review ran when the pull request opened (a submitted review with
line-level comments at 2026-08-03T00:09:56Z); 8 further commits landed after it,
between 01:00 and 03:35 that morning; and an `@coderabbitai review` at 03:40 and
an `@coderabbitai full review` at 04:13 were each answered by an ordinary issue
comment, with no submitted review and no new line-level comments. The 04:13 reply
also reported that the account's included review limit was reached under
CodeRabbit's Fair Usage Limits Policy.

Not established: whether those requests left the later commits unreviewed, or
reviewed them and had nothing to say. A review that finds nothing may simply
leave no submitted-review artifact, and nothing gathered rules that out; the
quota message confounds the trial as well.

So do not treat an `@coderabbitai review` request, or the reply to it, as proof
that the later commits were reviewed. It is not evidence either way.

## Who a lap belongs to

Lap attribution is decided by the lap's own completion time, not by who is
checked in when the lap arrives. The rig agent stamps every queued lap with the
assignment it believed was open when the lap was driven, and
`resolveAssignment` in `apps/web/src/app/api/agent/events/route.ts` will only
attribute a lap to an assignment whose window contains that timestamp.

This exists because the rig's outbox survives outages: without it, laps queued
during an outage land on whoever checked in before the connection came back.
`route.integration.test.ts` covers the four cases the rule has to separate.
Changing attribution means changing that one function - nothing else picks a
lap's owner.

## A combo typed one character off the sim's own name

Staff type a league round's track and car into a form; the rigs report iRacing's
own display names. `Dallara IR18` for `Dallara IR-18`, or a layout typed in for a
track that has none, and the two never match - so the round has no field, Fastest
Tonight has nobody, the wall is empty, and every rig is green with every lap
stored. There is nothing to search for, because nothing failed.

The rule that decides what counts tonight is a **string comparison in three
places**: `v_fastest_tonight`, `v_league_round_laps`, and `isOnCombo`
(`apps/web/src/lib/validity.ts`) for the one screen that asks in TypeScript. All
three ask it at read time, against whatever the combo says now.

`computeValidity` deliberately does **not** ask it. `is_valid` answers one
question - was this lap clean - and it is decided once and never revisited, so
nothing correctable belongs in it. Freezing combo membership there cost the venue
twice: the mistyped night could not be recovered even after the combo was fixed,
and a walk-in's clean lap at Monza during a league round at Spa was stored invalid
and so erased from Monza's own permanent arcade board. The combo still picks the
incident limit, because a raised limit is one of that combo's rules; a lap on
other content gets the venue's clean-laps-only default.

Two pieces close the loop, and both are one owner each:

- `describeComboMismatch` (`apps/web/src/lib/combo-mismatch.ts`) is what notices,
  and it reports only when **no** lap tonight is on the featured combo and the
  busiest other content has been driven at more than one rig. One rig off on its
  own is a customer who loaded the wrong car; some rigs off while others are
  scoring means the round is right. Repointing the night at either would void the
  rigs that are working, which is worse than the fault.
- `repointOpenRound` (`apps/web/src/lib/league-queries.ts`), behind
  `POST /api/staff/league/fix-combo`, is the repair: it changes the three names on
  the open round and today's featured combo in one transaction and nothing else -
  no round number spent, no empty round in the standings, no lap rewritten, and
  the `prior_featured_combo` snapshot the round gives back when it closes left
  alone. A closed round is never touched; its ranking is already published.

## Where the rig agent's files live

The agent is installed to a folder it may not write to (`C:\Program Files\`), so
nothing writable may sit beside the executable. `AgentPaths`
(`apps/rig-agent/OasisRigAgent.Core/AgentPaths.cs`) is the only thing that decides
a path: config beside the exe first then the data folder, and the outbox, log and
instance lock always in the data folder (`C:\ProgramData\OasisRaceControl\`,
moved by `OASIS_DATA_DIR`). Do not add a second path rule anywhere - a component
that needs a file takes the resolved path.

The claim that this actually holds on Windows is enforced by the last step of
`.github/workflows/rig-agent.yml`, which runs the published executable and fails
the build if it writes beside itself or lets a second copy start.

## A lap the backend refuses

The agent's outbox is resent as one document, so an event the contract cannot
parse fails the whole batch with a 400 and every lap behind it with it. Nothing
in that situation recovers on its own, so `BackendClient.SendLapsAsync` never
retries a 400: it halves the batch until the bad event is alone, and
`EventQueue.Quarantine` moves that one into a second table rather than deleting
it. A 500 or 401 still throws and keeps the whole batch queued - only a 400 is
treated as a verdict.

Adding a required field to `lapCompletedEvent` (`apps/web/src/lib/events.ts`) is
therefore not a free change: rigs still running the previous agent have laps in
their outbox in the old shape, and those laps get quarantined rather than
scored. `apps/rig-agent/README.md` has the full rule.

## The channels the agent reads from iRacing

The agent asks the sim for channels by name and a missing name decodes to null,
not to an error - so an unchecked mismatch silently turns off whichever lap rule
reads it. `TelemetryChannels`
(`apps/rig-agent/OasisRigAgent.Core/IRacing/TelemetryChannels.cs`) is the single
owner of that list: `LapDetector.WatchedVariables` is derived from it, so a
channel cannot be read without also being checked, and every channel carries the
role that decides what happens when it is absent.

A missing **validity** channel (pits, garage, in-car, replay, track surface,
incidents) withholds laps - it reads exactly like a lap where the condition never
happened, so publishing anyway puts pit laps and incident-laden laps on the
leaderboard as clean times. A missing **precision** channel only warns. Adding a
channel to the lap rules means declaring it here with its role; the decision to
make is what a rig should do when the sim does not have it.

`OasisRigAgent.exe --check-sim` answers the same question on demand and is what
confirms these names against a real iRacing install, one rig at a time.

The same verdict reaches `/staff` on every heartbeat as `simHealth`
(`scoring` / `unreadable` / `no_sim`) plus the channel names, so the room can be
read from one screen. It is a **live reading**, not a fact about the rig: the
heartbeat replaces `rigs.sim_health` outright rather than coalescing, an agent
too old to report it writes null, and the dashboard shows both null and a rig
that has gone quiet as `sim unknown` (`apps/web/src/lib/rig-health.ts` is the
only place that decides what staff read). A verdict that can go stale is worse
than none - a stale `scoring` is a rig quietly not scoring.

## A frame read from iRacing is one tick or none

The sim rewrites telemetry into a rotation of buffers at 60 Hz. A reader that
takes its channels one at a time, or is stalled by a garbage collection pause,
comes away with part of one tick and part of the next - and every value in that
stitched frame is a plausible number, so it reaches the lap rules as a lap
nobody drove. It is the only failure in the telemetry path that produces a
*wrong* leaderboard rather than a missing one.

`IrsdkMemoryParser.TryReadStableBuffer`
(`apps/rig-agent/OasisRigAgent.Core/IRacing/IrsdkMemoryParser.cs`) is the single
owner of that guarantee: copy the newest buffer in one read, keep it only if that
buffer is still the newest on the same tick afterwards, and otherwise report no
frame so the agent waits for the next one. Do not add a second path that reads a
channel straight out of shared memory - reading a value outside the snapshot is
what this exists to prevent.

Reading a frame cheaply is part of that guarantee, not separate from it: the
parser decodes the channel table and copies the session document only when they
change (they cost 104 us and 250 KB per frame otherwise, and that allocation is
what causes the pauses that tear a read). The channel table is still read from
shared memory every frame and compared byte for byte, because iRacing rewrites it
when the customer changes car - do not weaken that to a cheaper key. The session
document follows the sim's revision number instead, and
`IrsdkMemoryParser.RefreshSessionInfo()` is the only way to re-read one: the
source calls it when a document did not parse, which is how a half-written one
gets a second look. `IrsdkParserSteadyStateTests` holds the per-frame budget.

The "still the newest" half is deliberately stronger than iRacing's own client,
which re-checks only the copied buffer's tick. That is not enough for a stalled
reader: the sim writes a buffer's data before stamping the tick that claims it,
so a writer that has come all the way back around is rewriting bytes under a tick
that has not moved. `RefusesABufferTheSimHasComeAllTheWayBackAroundToRewriting`
holds that line, and the agent's own class comment explains why being conservative
here costs nothing.

## The reader a rig runs was the one thing no test ran

Everything above the mapping - the frame parser, the session document, the lap
rules, the whole live source - was proved against a byte array standing in for
iRacing's shared memory. The reader a rig actually uses was a private class inside
the Windows-only attachment code: unconstructable off Windows and constructed by
nothing on it, so it and every Windows call under it first ran on a venue computer.

`MappedViewReader` (`apps/rig-agent/OasisRigAgent.Core/IRacing/MappedViewReader.cs`)
is its own file for exactly that reason - a `MemoryMappedViewAccessor` is not
Windows-only, so the production reader is driven wherever CI runs
(`MappedViewReaderTests`, over a mapping the operating system really made). Three
things a mapped view does that an array does not, and each of them is a lap:

- **The view is larger than the sim published into it.** Windows sizes it by the
  mapped region, rounded up to whole pages, so capacity is an upper bound the agent
  may not read past - never a statement about how much iRacing wrote.
- **A read that runs off the end comes back short, not loud.** `ReadArray` clamps
  and reports how much it copied, so an unchecked read hands the parser real bytes
  followed by a tail of nothing - the frame stitched from two ticks that the
  copy-and-check protocol exists to refuse. The length check in `Read` is that
  refusal, and the empty-read guard above it is for the zero-length session
  document, which a view rejects at its own end.
- **It rents rather than allocates.** A frame is several reads, and allocating each
  one costs 44 KB a frame - 22 times the budget `IrsdkParserSteadyStateTests` holds,
  and at 60 Hz that is the collection pause that tears a read. The budget is measured
  through this reader now; measured through an array it cannot fail.

The Windows half - finding iRacing by name, opening the mapping with read rights
alone, taking a view of it, opening the frame signal by hand with `SYNCHRONIZE` and
nothing else, waiting on it, and letting all three go so a restarted sim is seen as a
new one - is `WindowsSimAttachmentTests`, which runs for real on the Windows runner
against a mapping it publishes itself. Those are claims about Windows rather than
about this repository, and they are identical on all twenty-plus rigs: if any is
wrong the whole room reads "iRacing is not running" and no lap is ever scored. They
are guarded by a platform check, so `OASIS_REQUIRE_WINDOWS_SIM_TESTS=1` in
`.github/workflows/rig-agent.yml` fails the job if they did not actually run there -
the same lie `OASIS_REQUIRE_DB_TESTS` closes in the web job.

The test project is the one place in this repository allowed to write into a
shared-memory mapping, because proving a read-only attachment needs something that
writes. The "Keep the simulator read-only" scan is therefore scoped to the two
projects that ship, with a file-count floor so a mistyped root cannot silently scan
nothing, and the publish step fails if `OasisRigAgent.Tests.dll` ever reaches the
artifact. Do not widen that exemption.

## A lap's time and its counter are two channels, and the order is not documented

`LapCompleted` and `LapLastLapTime` are separate telemetry channels and nothing
says which of them the sim moves first. iRacing's own reference gives
`LapLastLapTime` a type and a unit and no timing; `docs/spike-findings.md` still
carries it as an open row, and no venue recording has answered it.

Reading the time on the frame the counter moved is only correct under one of the
two answers. Under the other, every lap on every board carries the *previous*
lap's time - plausible number, plausible ordering, every rig green - and because
drivers get quicker through a stint, the lap they are telling their friends about
is the one that is missing.

`LapDetector` therefore never reads the time at the line. It compares the channel
against what it was holding on the frame *before* the crossing and keeps the lap
until it moves: same frame, nothing is delayed; a few frames later, the lap is
kept then; nothing within two seconds, the lap is given up on rather than sent
with a number that came off the lap before it. The rules to preserve:

- **The lap is stamped with the crossing, not with the settle.** `CompletedAt`
  decides which check-in owns it (`resolveAssignment`) and which night it counts
  for (`venue_today()`), and both are about when the driver crossed.
- **Everything else is read at the line.** The incident delta is a movement across
  the lap and the off-track and pit flags are cleared for the lap starting now, so
  an incident taken while the sim was still publishing the last time belongs to
  the lap the driver is on. `PendingLap` carries the snapshot for exactly this
  reason - do not re-read those channels when the time turns up.
- **A crossing while a lap is waiting drops the waiting lap.** Two laps must never
  be settled by one publication, and the settle window is far shorter than the
  shortest lap the venue keeps, so this is a corrupt-stream path rather than a
  racing one.

The cost is one lap when two consecutive laps are timed to the same ten-millionth
of a second, which nobody drives. The spike recorder measures the real answer:
`LAP_BOUNDARY.timeMovedWithTheCounter` and `LAP_TIME_SETTLED.framesAfterTheLine`
(`spike/OasisSpike/Recorder.cs`), and the settle window has to stay longer than
whatever a venue session reports.

## An iRacing update can stop the whole room scoring on the same day

iRacing stamps a layout version on its shared-memory telemetry, and every offset
the parser follows is only meaningful under it. `IrsdkMemoryParser` reads that
version first and refuses anything but
`IrsdkMemoryParser.SupportedLayoutVersion`, before the checks a moved header
would have invalidated - otherwise the reported reason is whichever range check
happened to fail, which is a fault nobody has, and a layout guessed at still
yields plausible lap times.

This is the update failure worth designing for. iRacing updates are forced and
the venue takes the same one within a day, so it is never one rig - and before
this, an undecodable mapping left the agent logging every couple of seconds to a
file on the machine and reporting `no_sim` everywhere else, which is exactly what
an idle rig reports. That was the third instance of the same shape, after a
missing channel and an out-of-reach sim.

`SimDecode` (`apps/rig-agent/OasisRigAgent.Core/IRacing/SimDecode.cs`) is the
single owner of what to say, in the same two lengths and for the same reason as
`SimReach`. It reaches `/staff` through the existing heartbeat chain with no
schema or contract change (`simHealth` `unreadable` plus the reason), and
`--check-sim` exits 6 immediately rather than spending its patience.

Two properties in `IRacingTelemetrySource` are the contract, not incidental.
The verdict is **not** cleared by `Detach`, unlike everything else a connection
teaches that source: it describes what the simulator on this machine publishes,
so dropping it with the connection would have the rig back to looking healthy two
seconds later and flicker the dashboard all night. And a single unreadable frame
never sets it (`MalformedReadsTolerated`) - a mapping caught mid-rewrite is an
ordinary event with its own answer, and turning one into a red rig card makes the
dashboard useless on the nights it is for.

## Where Windows starts the agent decides whether it can see iRacing at all

iRacing publishes into `Local\IRSDKMemMapFileName`, and `Local\` scopes that name
to one Windows sign-in session. A process in another session gets "not found",
not "denied" - byte for byte the answer the agent gets between customers - so it
reports an idle rig forever. A Windows Service and a "run whether the user is
logged on or not" task both land in session 0; running as a different Windows
user than iRacing lands beside it with a refused open. An install is written down
once and followed twenty-plus times, so either arrives on the whole room at once.

`SimReach` (`apps/rig-agent/OasisRigAgent.Core/IRacing/SimReach.cs`) is the single
owner of that separation, and it returns a verdict in two lengths on purpose: a
short summary for the rig's status line and the `/staff` card, and the full
instruction for the log and `--check-sim`. Putting the whole explanation on the
card turns a rig tile into an eleven-line paragraph nobody reads.

It is consulted only after a failed attach, so it can never withhold a lap from a
rig that is reading its sim - do not move that call. `docs/deploy.md` "Starting it
automatically" is the operator-facing half, and the last step of
`.github/workflows/rig-agent.yml` performs the mistake for real on Windows.

## The rig's clock

A lap's timestamp decides two things - which check-in owns it
(`resolveAssignment`) and which venue night it counts for (`v_fastest_tonight`,
`venue_today()`) - and both are judged against the server's clock while the
timestamp comes from the rig's. A rig minutes behind has its laps refused for
good; a rig hours ahead has them stored, attributed, and filtered off tonight's
board. Nothing reports either.

`ServerClock` (`apps/rig-agent/OasisRigAgent.Core/ServerClock.cs`) is the single
owner of that correction. It measures the offset from the `Date` header on every
backend response (via `ServerClockHandler` in the HTTP pipeline, so a call added
later is a reading too) and `AgentService` stamps every queued lap through it.
Do not add a second place that adjusts a lap's time, and do not use the corrected
clock for the agent's own interval timing - `IRacingTelemetrySource` measures a
stalled simulator against the machine's raw clock, and a correction landing
mid-run would read as a dead sim.

Differences under two seconds are reported as no correction at all, so a healthy
rig's laps keep the machine's own timestamps exactly; that deadband is what makes
this safe to roll out across the fleet.

## One rig token on two computers

A rig's bearer token is its whole identity: `rigFromBearer` finds one rig row and
every lap that arrives with it is credited to whoever is checked in there. A
venue installs twenty-plus simulators by copying one machine's folder, so the
realistic mistake is `agent.config.json` travelling with it - and before this was
caught, two simulators merged into one rig with no error anywhere and half the
board belonging to the other customer.

Every heartbeat now names the computer it came from. `InstallationIdentity`
(`apps/rig-agent/OasisRigAgent.Core/InstallationIdentity.cs`) is the single owner
of that id: a seed in the agent's data folder - never beside the executable, or a
copied program folder would copy it - hashed together with the machine's name, so
a copied folder, a cloned image and an ordinary restart are all distinguishable.

The claim is settled in `recordHeartbeat`
(`apps/web/src/app/api/agent/events/route.ts`) inside one statement, so two
agents heartbeating at the same instant cannot both decide they own the rig.
`rig_installation_live()` (db/migrations/0004) is the one owner of "recently
enough to count", used by the takeover rule, the events API and `v_rig_status`.
A quiet installation is taken over silently, because replacing a rig PC is
ordinary maintenance; a live one is a conflict, stamped rather than cleared so it
ages out on its own when the second machine is given its own token.

While a rig is contested its laps are answered `rig_conflict` and nothing is
stored - there is no honest answer to whose lap it is. That status is
deliberately absent from the agent's `SettledStatuses`, so the laps stay in each
machine's outbox and deliver themselves after the fix. Do not add it: a refusal
that reverses itself must never settle a queue entry.

## A clean lap is not the same as a 0x lap

The venue's rule is clean laps only, and iRacing's incident count does not
enforce it: the sim charges no point for a great many trips off the road, and
the off it is most likely to let go is running wide on exit, which is also the
one that gains time. So the lap arrives 0x, faster than every clean lap, and
nothing about it looks wrong.

The agent watches the surface itself (`LapDetector`, `PlayerTrackSurface == 0`
accumulated across the whole lap and cleared at the line) and reports
`offTrackSeen` on the lap event **beside** `incidentDelta`, never folded into it.
`computeValidity` (`apps/web/src/lib/validity.ts`) is still the only thing that
decides whether a lap was clean: it charges an uncharged off as one incident
against the limit using `max`, not a sum, so an off the sim did charge is not paid
for twice and a venue tolerating one incident is not made stricter about the off
iRacing forgave. (Whether a clean lap counts *tonight* is a separate question,
asked at read time - see "A combo typed one character off the sim's own name".) The reason is `OFF_TRACK`, not `INCIDENT_LIMIT_EXCEEDED`,
because the driver is looking at 0x on their own screen.

`offTrackSeen` is optional on the wire and absent means no off was seen. Rigs are
updated one at a time - a required field quarantines every queued lap on every
rig (see the section above), and reading absent as "unknown, so void" would wipe
out the night on every machine the update has not reached.

## Nothing tells this system when a customer's time is up

Staff sell time at the desk; there is no paid-time signal. A walk-in who is
finished stands up and leaves their check-in open, and the next person to sit down
almost never rescans a rig that already has a session loaded and a name on the
screen - so their laps land on the previous customer everywhere the venue shows a
result, with no error anywhere.

`IdleWatch` (`apps/rig-agent/OasisRigAgent.Core/IdleWatch.cs`) is the single owner
of the rule that decides the seat is empty, and it counts exactly one thing:
iRacing closed, continuously, with a check-in open. Two readings must never count -
a running simulator (a customer parked in the garage is still a customer), and a
simulator the agent cannot read, which is the same reading a whole mis-configured
fleet reports from the moment it starts and would empty the venue's check-ins one
period after the install. The period is measured from a monotonic reading, never
the machine's clock (see the rig's clock, above).

The sign-out names the check-in it judged. `POST /api/agent/checkout` closes that
one or nothing, because a walk-in can scan the QR code in the gap between the
decision and the request - the same "who was in the seat when" rule as lap
attribution. The route also fixes what an agent may claim: `switched` (the rig's
own button) and `idle_timeout`, never a reason belonging to staff or check-in.
`idleTimeoutSeconds: 0` turns the whole behaviour off per rig. A customer who
leaves iRacing *running* is still a staff clear - that seat looks occupied from
here.

## Which machines took the update

There is no auto-update, and the update that forces the issue is not optional: a
forced iRacing build can stop the whole room scoring on the same day (above), and
only a new agent fixes it. That is a walk round twenty-plus computers, and the
version each rig reports is the only record of which ones are done.

`AgentVersionInfo` (`apps/rig-agent/OasisRigAgent.Core/AgentVersionInfo.cs`) is
the single owner of that number and reads it from the running assembly. It was a
field in `agent.config.json` for sixteen rounds of work, which is the one file an
update must *not* overwrite - it holds the rig's token - so the number was frozen
at install (in practice at a default, `rig-agent/0.1-skeleton`, that no operator
was ever told about) and installing a new build could not change it. A config
that still carries the line is ignored and reported, never obeyed. The build
lives in `apps/rig-agent/Directory.Build.props` so every project stamps the same
one, and `--version` prints exactly what the rig heartbeats.

The dashboard reads the round off those reports, with nothing configured: the
newest build any rig has reported is the target, so the count starts working from
the first machine updated, and `describeFleetBuild` / `describeRigBuild`
(`apps/web/src/lib/rig-health.ts`) are the only place that decides it. Builds are
ordered by their numbers, never as text - `0.10.0` follows `0.9.0`, and by text it
does not, which during a round would read as every updated rig being behind. A
build that cannot be read as a number never becomes the target but does count as
still to update; a rig that has never reported one is left alone, because its card
already says `no agent`.

## Getting the agent onto twenty-plus machines

Three of the venue's worst failures - a rig on another machine's token, an agent
started where it can never see the simulator, a rig left behind by an update round
- are install mistakes rather than bugs, and an install runbook is written once and
followed twenty-plus times, so each arrives on the whole room at once.

`apps/rig-agent/deploy/Install-RigAgent.ps1` is the single owner of enrolling and
updating one rig, and it is written to make those three unreachable, not to save
typing. The properties not to weaken:

- **A rig's identity is never copied.** The token comes from the command line at
  enrolment and from the machine's own config afterwards. A source folder carrying
  `agent.config.json` is refused, because that is what a copy of a working rig's
  folder looks like, and an update passed an identity is refused too.
- **`Get-RigInstallPlan` decides the whole run before anything is stopped or
  written.** A refusal must not have taken a scoring rig off the air on its way to
  saying no, and whether a config is written is settled in the plan rather than at
  the moment of writing, so an update cannot drift into rewriting the one file it
  has to leave alone. The plan puts a new identity in the data folder, never beside
  the executable, which is where the next build lands.
- **The logon task is read back from Windows, not assumed.** Registering it is not
  the same as it being right: anything but an interactive logon task runs in session
  0, where iRacing's telemetry has no name. `SYSTEM` and the service accounts are
  refused by name.
- **The install verifies rather than reports.** The build is read back off the
  executable it just copied, the agent it started has to still be running a moment
  later, and `--check-sim` decides the exit code - `4` ("no iRacing here") reads as
  done because that is the ordinary answer at an empty rig, while `5` and `6` do
  not.

The rules run on any machine (`Install-RigAgent.Tests.ps1`, Pester); the Windows
half - the task principal, stopping a running agent, asking the installed exe which
build it is - is performed for real on every pull request by
`.github/workflows/rig-agent.yml`, which enrols a rig with the runbook's own command
under Windows PowerShell 5.1, updates it, and tries all three refusals. Keep the
installer 5.1-compatible: that is the shell a venue machine has out of the box.

## Where a rig's token comes from

A rig's bearer token is its whole identity to the backend, and until `/staff`
could mint one the only tokens that existed anywhere were the three deliberately
guessable ones in `db/seed.sql`. Enrolling twenty-two machines meant writing
sha256 hashes into production Postgres by hand, and a venue that skipped that
step ran on `dev-rig-1-secret` - a token anybody who has read this repository can
post laps with.

`apps/web/src/lib/rig-enrolment.ts` is the single owner of minting, and three
rules in it are the contract:

- **The server mints; the request never supplies.** `POST /api/staff/rigs` takes
  a rig number and a name, never a token, so no rig can be given a short one, a
  reused one, or another rig's.
- **Only the hash is stored**, through `agentTokenHash` in `lib/agent-auth.ts` -
  the same function `rigFromBearer` authenticates with, so the two cannot drift.
  The plaintext exists in one HTTP response and nowhere else: not in the row, not
  in the audit detail, not in a log line. That is what makes the UI's "shown once
  - not recoverable" true rather than a slogan, and it is why `POST
  /api/staff/rigs/rotate-token` has to exist at all.
- **A rig is created whole.** The bearer token and the QR slug the customer scans
  are written in one transaction, because a rig with one and not the other is a
  machine that scores laps nobody can check into, or the reverse, and neither
  failure names itself.

Rotation is the venue's only revocation: the old token stops being accepted in
the same statement that writes the new one, and that machine reads `⛔ TOKEN
REFUSED` (see below) until it is re-enrolled. It deliberately leaves the QR slug
alone - re-issuing a token must not mean reprinting twenty-two QR codes.

## A rig the backend will not authenticate

Every backend call the agent makes funnels through one `RunBackend`, and it used
to produce one answer for every failure: `offline`. That is honest about a dropped
network and the opposite of the truth about a refused token - there the network is
fine, the backend is answering, the refusal is permanent, and the rig queues every
lap of the night while being *absent* from `/staff` rather than wrong on it (a rig
that cannot heartbeat has no card to be red, so it reads `AGENT OFFLINE / no
agent`, exactly like a machine nobody installed). The rig is the only place that
can know.

`BackendReach` (`apps/rig-agent/OasisRigAgent.Core/BackendReach.cs`) is the single
owner of that separation, in the same two lengths and for the same reason as
`SimReach` and `SimDecode`. A 401 or 403 from **any** call raises
`BackendRejectedException`, so the rig says the same thing whichever timer ran
first, and it derives from `HttpRequestException` so every existing "a failed call
means offline" path is unchanged - the laps still queue, nothing is settled, and
nothing is quarantined.

Three properties are the contract. A dropped network never *sets* the verdict
(only a status the backend chose does, or twenty rigs behind one flaky router all
report a token problem); a dropped network never *clears* it either (or a refused
rig on a flaky network flickers back to the word that reads as "wait for the
wifi"); and the refusal is raised before `SendLapsAsync`'s 400 branch, because
halving a batch to find "the one bad lap" would quarantine good customer times to
explain a wrong token.

The reason this failure is worth its own machinery is enrolment. A rig's token is
the only part of an install typed by hand and never read back, once per machine,
twenty-plus times in an evening. `OasisRigAgent.exe --check-backend` answers it on
the spot over the same code path the agent uses (one authenticated *read*, no
lock, no lap touched, before the config lock so it runs beside a live agent), and
`Install-RigAgent.ps1` runs it before the simulator check: exit `8` stops the
install reporting done, while exit `7` ("could not be reached") does not, because
enrolment is often done on a bench before the venue network is up. Keep those two
apart - collapsing them sends somebody round twenty machines retyping secrets that
were right all along.

## A computer holding another rig's token

The failure above stops everything, which is at least visible. This one stops
nothing. A rig's bearer token is its whole identity to the backend, and the rig
number in `agent.config.json` never travels - it is what the machine calls itself
on its own screen and nowhere else. Paste rig 7's install command at the machine
standing at station 4 and it authenticates, heartbeats, polls, and delivers: every
lap driven there is credited to rig 7 and to the customer checked in over there,
while the customer at station 4 watches a board their times never reach. Nothing
in the database looks unusual.

Neither side can see it alone, which is why the comparison had to be built rather
than queried. `GET /api/agent/assignment` now answers with the rig it
authenticated (`rig: { number, displayName }`), and `RigIdentity`
(`apps/rig-agent/OasisRigAgent.Core/RigIdentity.cs`) is the single owner of the
verdict, in the same two lengths and for the same reason as `BackendReach`.

Four properties are the contract, not incidental:

- **It only ever fires on two real numbers that disagree.** A backend that does not
  report the rig (older than the agent, or mid-deploy) and an unreadable number both
  change nothing. This stops a rig scoring, and every rig in the venue runs it.
- **The laps are held in that machine's own outbox.** Sending them is the damage;
  they deliver onto the right rig once it is re-enrolled.
- **It stops heartbeating.** A heartbeat is a claim on a rig, and a second live
  installation puts that rig into conflict and holds its laps too - so one wrong
  paste must not take a working machine off the air. It keeps polling, which is
  how it learns the token was fixed.
- **The other rig's check-in never reaches this screen or this machine's queue.** A
  lap stamped with it is answered `assignment_mismatch` after the repair, which the
  agent settles and drops - losing the customer's time to the fix rather than the
  fault.

Every loop runs immediately at startup, so both of those last two guards have to
be *waited on* rather than checked: `_identityChecked` in `AgentService` is
completed by the first poll to finish, after its verdict is recorded, and the
heartbeat and flush await it. Checking a flag instead loses two races that were
only visible against a real backend - a beat that goes out before the answer
arrives stamps a conflict on the impersonated rig, and the first flush after a
restart empties a full outbox onto the other rig's customer, which is the exact
damage the guard exists to stop. In-process the fake backend answers without ever
yielding, so a test of either needs a poll slower than the loop racing it.

`--check-backend` exits 9 for it and `Install-RigAgent.ps1` exits 8, both kept
apart from the refused-token codes: nothing here is refused, so anybody sent
looking for a mistyped secret is looking for something that does not exist.

## A lap queue this machine can no longer read

A venue PC loses power mid-write, has its folder copied while the agent is
running, or is handed a file a backup tool half-restored, and SQLite refuses
`outbox.db` afterwards. That used to happen at startup, before anything, so the
agent did not start - and a rig that cannot heartbeat has no card on `/staff` to
be red, so it read `AGENT OFFLINE / no agent`, exactly like a machine nobody
installed it on. Restarting is what people try, so it reproduced itself every
time. The message said `Configuration error` and named `agent.config.json`, the
one file that was fine.

`EventQueue`'s open path (`apps/rig-agent/OasisRigAgent.Core/EventQueue.cs`) is
the single owner of the recovery, and four properties are the contract:

- **Only an unreadable database is replaced** - `SQLITE_CORRUPT` or
  `SQLITE_NOTADB`, primary or extended. A folder the account does not own, a full
  disk, or a file something else holds throws `OutboxUnusableException` and the
  agent stops with exit `10`. Renaming a queue aside every night while still
  failing to start turns one loud failure into a nightly silent one, which is the
  opposite of what this is for.
- **`pragma quick_check` runs at open.** The schema statement reads page one only,
  so a file whose header survived the power cut opens happily and fails at a flush
  hours later with a customer's laps in it.
- **The damaged file is kept** as `outbox.damaged-<UTC>.db`, byte for byte, with
  its journal and WAL moved with it - a stale journal left beside the fresh queue
  is how a recovery makes the second corrupt file. Capped at three, like the log
  and the quarantine.
- **It is said at `Error`, naming both files and that the queued laps were lost.**

Do not add a second place that opens the outbox, and do not widen the replaced set
to "any failure to open" - that distinction is the whole safety property.

The Windows half cannot be proved on another platform, so
`.github/workflows/rig-agent.yml` performs it: `Microsoft.Data.Sqlite` pools
connections, so the handle left by the failed open is what blocks the rename, and
`SqliteConnection.ClearPool` is what releases it. On macOS and Linux the rename
succeeds regardless and a missing `ClearPool` is invisible.

## A lap id is the idempotency key, so two laps sharing one is a lost lap

`event_id` is unique on `laps` and the ingest inserts `on conflict do nothing`, so
a lap arriving under an id already stored is dropped and answered `duplicate`.
That is correct for the case it exists for - a rig re-sending a lap whose answer
it never got - and it means any *other* way two laps end up with one id is a
silent loss: the rig gets a 2xx, the lap leaves the outbox, `/staff` is green, and
the customer is not on the board.

The id used to be `rig + SessionUniqueID + SessionNum + lapCompleted`, derived
rather than minted so a resubmission would collide on purpose. It collides on
purpose with the wrong things too. A driver restarting their session starts at lap
1 again, and whether iRacing gives the next session a different `SessionUniqueID`
has never been established against a live install (`docs/spike-findings.md`) - so
the second run of lap numbers re-spends the first run's ids. Driven for real, one
rig and two customers on one combo put three of six laps on the leaderboard.

`LapDetector.BuildEventId`
(`apps/rig-agent/OasisRigAgent.Core/IRacing/LapDetector.cs`) is the single owner,
and the properties are:

- A **run token** (`-t<agent run>x<run of lap numbers>`) is what makes the id
  unique. The sim's own session id and number are still in the string so a lap
  says where it came from, and nothing relies on them to keep two laps apart.
- The token turns over in exactly one place - `StartNewLap` when the lap was not
  watched from its start, which is every way a run of lap numbers can begin. All
  the laps of one stint share it, which is what lets a stint be reconstructed from
  ids alone.
- The agent run is named with a random component, not a millisecond clock. These
  are the machines whose clocks are known to be wrong (`ServerClock`).
- The instance id is bounded where it enters (`Sanitize`), because the identity is
  trimmed to the backend's 128 characters and the run token is at the end.

Resubmission idempotency lives in the outbox, not the derivation: a queued lap
keeps the id it was minted with, and a lap the agent did not watch from its start
is never emitted, so a restart cannot produce one twice.

`describeDuplicate` (`apps/web/src/app/api/agent/events/route.ts`) is the backstop.
A duplicate whose stored lap differs from the arriving one is logged `LAP LOST -
two different laps carry one event id` with both. Do not turn that into a new wire
status: a rig too old to know it would retry the lap until closing time and hold
every lap behind it.

## The venue is one address, so nothing may be throttled by it

Every phone in the building reaches the site from one public address - the guest
wifi behind NAT, and the carriers' own NAT for the ones on cellular. A per-address
throttle on the sign-up routes therefore throttles *the venue*: driven for real,
twenty-two customers arriving over twenty seconds put ten on track and turned
twelve away, and the same room spread over ninety seconds still lost five. The
customer's own screen said "Something went wrong - try again", which reads as a
fault at the site rather than a wait.

The cost is not a slow check-in, it is a lost stint. A customer who cannot check
in sits down and drives anyway; the rig has no open assignment, so every lap is
answered `no_active_assignment`, which the agent settles and drops. There is
nothing left to recover.

`allowNewDriver` (`apps/web/src/lib/rate-limit.ts`) is the single owner of that
decision for both `POST /api/auth/guest` and `POST /api/auth/register`, and the
key is the rule: **a seat, not an address.** A rig holds one person, so a rig
producing drivers faster than a person can sign up is abuse, while twenty-two
seats between them cannot reach a total the venue would notice. Two properties
are not incidental:

- **The code is resolved against the fleet before it is trusted.** An unknown one
  is not a seat and falls back to the address bucket, so a made-up code cannot
  mint an unbounded number of fresh buckets. That is also why the throttle runs
  *after* the body is parsed rather than before it.
- **The refusal names itself.** `rate_limited` has its own message in
  `auth-forms.tsx` because the generic one sends the customer to find staff for
  something that clears itself in under a minute.

`/api/auth/login` is deliberately not in here: it is throttled per driver
(`checkLockout`), which is the right key for a PIN, and an address bucket on it
would lock out the room for one person's typing.

## What CI enforces, and the way it could have lied

Both halves of the venue run under CI now: `.github/workflows/rig-agent.yml`
for the agent on the rigs, `.github/workflows/web.yml` for the app that decides
what the leaderboard, the wall and a customer's phone show. The web job stands
up a real Postgres because the rules that decide a night are SQL -
`v_fastest_tonight`'s venue day, `v_league_round_laps`, the `event_id`
idempotency key, the one-open-assignment indexes - and a mocked pool asserts
nothing about any of them.

The thing worth knowing is why `OASIS_REQUIRE_DB_TESTS=1` is set there. The
database-backed suites are written to **skip** without a database, so `npm test`
is green and honest for a developer with no Postgres. But vitest exits 0 on "43
skipped" exactly as it does on "43 passed", so a service container that never
became healthy, or a typo in `TEST_DATABASE_URL`, would have left every one of
those rules unproven behind a green tick. `requireTestDatabase`
(`apps/web/src/test/db-guard.ts`) is the single owner of that decision - both
the integration suite's global setup and the SQL-backed unit suite ask it, so
they cannot drift into answering differently. Do not let a new database-backed
suite skip without going through it.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
