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

`/tv?event=1` is the event view for a laptop at an off-site event: one board,
every driver with a lap today in the featured combo, scrolling on its own
(`auto-scroll.tsx`), no rotation. It is a second rotation *list* (`TvMode` in
`tv-rotation.ts`, chosen by `buildRotation`), not a second engine or a second
board type - the tonight board plays it with `everyone: true`, asking the
tonight feed for `limit=all`. Do not give it a row ceiling back:
`v_fastest_tonight` is already bounded by the day's drivers, and any fixed cap
drops the next driver silently (pinned by the tonight route's
`route.integration.test.ts`). It exists because at an off-site event the
venue rotation shows the same laps under three headings: a league slide with
no season, which is counted in the footer but never plays, then "Fastest
tonight" and "All-time best laps", identical when every lap the database holds
was driven today. Plain `/tv` is unchanged by it.

Sizing is one composition, not per-element pixels. The wall renders at
**1272x601** - not 1080p - so `/tv` is written entirely in `em` of the
`.tv-scale` root in `globals.css`, where `1em` is one rem of a 1920x1080 design
and the root scales to whichever axis the real screen runs out of first. A new
board must be written in `em` too: a `rem` or a plain Tailwind size class
(`text-3xl`, `p-10`, `w-64`) is a fixed pixel count that will not shrink with
the rest, which is how rows came to overlap and the car column to render
"Ferr...". Two matching rules in `arcade-board.tsx`: columns whose content
varies are `fr` tracks, and rows carry a `min-h` tied to their own text so they
can stretch but never collapse.

Every board also carries a corner QR code (`phone-standings-qr.tsx`). On the
shop rotation it opens `/leaderboards` on the page's own origin - nothing
configured, so it is right on the hosted site and a preview; open `/tv` on
the hosted address, never `localhost`, because that code encodes the page's
own origin. On the event view it opens the Oasis website
(`OASIS_WEBSITE_URL`) instead: the owner asked for that after the 2026-09-27
event, because the leaderboard's site menu hands the public every other
screen including the staff login. Do not make that target a query parameter.
It sits in the footer's flow rather than pinned over the board, which is what
makes it unable to cover a row; `npm run tv:check` screenshots `/tv` and fails
on any overlap (root README, Integration tests).

For the same reason the event view shows no app-wide Screens menu: nothing on
it may navigate to another screen of the app, since any visitor can tap a
touch display. The menu lives in the root layout, which cannot see the query,
so it is in every page's server HTML and the `/tv` page hides it - its `main`
carries `data-tv-mode`, and a `body:has(...)` rule in `globals.css` sets the
menu's `data-screen-menu` root to `display: none`. Do not make the menu read
the query string instead: `useSearchParams` in the root layout needs a
Suspense boundary that takes the menu out of every prerendered page's HTML.
`npm run tv:check` fails if the button shows on the event view or not on the
rotation.

A board can also take the wall over rather than take a turn on it, without any
engine change: renew the contract's `hold()` on every refresh while the takeover
condition holds. The league board does exactly that while tonight's round is
open. Bound any such condition by the venue day - nothing closes a round by
itself, and an unbounded takeover owns the wall until someone notices.

The event view is also the one `/tv` surface that reacts to input: its list is
a real scroll container the whole time, and the first touch, press or wheel
converts the animation's current offset into a native scroll position on a
single copy of the list (`auto-scroll.tsx`), resuming from the leader's hold
after `IDLE_RESUME_MS` untouched. The frame allows only vertical panning and
`main` disallows every other touch gesture.
A mouse or pen press-and-drag scrolls it too (`drag-scroll.ts`), because the
event laptop is a Mac, where an external touch display reports a finger as a
mouse and nothing pans natively; real touch stays with the browser.
Verify any change to it with a real gesture, not a synthetic event: `npm run
tv:scroll-check` against a production build drives a CDP touch swipe, the
wheel, a mouse drag and a click, and waits out the idle resume after each;
the same CDP gesture is what proved that a live refresh leaves a held list
where it is.

The footer's host slot belongs to the event, not the engine. `&host=<name>` on the event
view draws a bundled host lockup - the host's mark and, when it has one, its
wordmark as an image in the host's own lettering - where the rotation names
its board (`apps/web/src/lib/tv-host-logo.ts` is the allowlist; every file
under `public/host-logos/` must be the host's own official artwork, unaltered,
with its source URL recorded beside the entry, and tinted for the dark board
in CSS). Cadillac's is the crest plus its current all-caps wordmark: the owner
first asked for the cursive script signature, which no official Cadillac or GM
site serves, and chose the caps wordmark instead.

The tonight board marks a lap that had an incident with an asterisk
after its time and nothing else: the owner asked for the mark alone, and had
the footer legend that first shipped with it removed, so do not add one back.
The incident count behind it is read off `laps` in the tonight feed's own
query, not from `v_fastest_tonight`, so the view is not redefined for a
display detail. Only valid laps rank, and validity is decided once, at
ingestion, against the featured combo's `incident_limit` at that moment
(`computeValidity`, stored in `laps.is_valid`): an incident lap is marked on
the board only if the limit admitted it when it arrived, and changing the
limit afterwards neither ranks nor unmarks laps already stored. The staff
panel writes 0 by default, so on an ordinary day nothing is marked. The mark
counts any iRacing incident, not only off-tracks - the owner accepted that on
2026-09-27, when the event's combo was raised to 999 mid-event.

## Verifying `/tv` failure behaviour needs a production build

Test feed outages against `npm run build && npm run start` (from `apps/web`; there
is no root `package.json`), not `npm run dev`.
Next's dev HMR client force-reloads the page when the dev server dies, so the tab
lands on Chrome's own error page and you cannot tell whether the app recovered.
Under `next start` the page stays put and self-heals, which is what the kiosk does.

Build while the database is still reachable: with `DATABASE_URL` set, `npm run
build` fails when it cannot verify that database ([the gate
below](#migrations-ship-before-code-and-the-build-enforces-it)), so a rebuild
during a simulated *database* outage needs `SKIP_MIGRATION_CHECK=1`.

## League night

- Shop owner's shape for the league: a season IS a calendar month, and a round runs
  every Wednesday - roughly four or five rounds a season, twelve seasons a year.
  So ending a season is a routine monthly job for whoever is on shift, not an admin
  operation: `/staff` rolls it (`rollLeagueSeason` in `apps/web/src/lib/league-queries.ts`),
  and a new season defaults to its venue-local month name (`venueMonthName`).
  Nothing rolls a season on a date boundary by itself - the trigger stays human.
- A round owns laps by time window + combo; laps carry no round id. The rule lives
  in one place, `v_league_round_laps` - introduced in
  `db/migrations/0002_league_night.sql`, and last redefined by
  `db/migrations/0003_unattributed_laps.sql`, which is where the current
  definition is - and every league query joins through it. Change the rule in
  that latest definition, nowhere else.
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
  is the sum of every round entered - no drops.
- League night is open qualifying then a race in one hosted iRacing session, and
  the owner's rule (2026-10-01) is that a round with a race result is placed by
  its finishing order plus 1 bonus point for the fastest valid qualifying lap;
  a driver with laps but no race finish still scores the 1. A round with no
  race result is placed by fastest lap with no bonus, which keeps every round
  played before races were recorded scoring as it did. Placing stays in the one
  query (`queryRoundResults`), points stay in `league-scoring.ts`.
  `lib/race-results.ts` is the only writer of the result: captured from race
  reports at the chequered flag, swept at close, corrected and frozen by staff
  on `/staff` ([docs/live-race.md](docs/live-race.md#the-race-result)). The
  round's race is `v_league_race_session` - the race session the most rigs
  were heard in while the round was open, and never one heard from a single
  rig, so a walk-in's solo race on a spare rig is never it. The flag capture,
  the qualifying cut-off and the close sweep all read that view; a capture
  must never delete another session's rows. Two more rules are easy to undo:
  a captured row names the driver from the assignment the race-status route
  stored with the report (`rig_race_status.rig_assignment_id`), never from
  whoever holds the seat when the row is written - the close sweep reads
  reports minutes old - and a rig's first place at the flag is final, since
  the live feed deliberately accepts an older report after a quiet rig, so
  only staff move it. A rig flagged with nobody signed in records an empty
  place (`league_race_unsigned_places`, 0010) so a cool-down sign-in never
  takes it. A staff save carries the review's `capturedThrough` and is
  refused once a newer capture exists; that only holds because captures lock
  the round one at a time and stamp `clock_timestamp()`.
- Opening a round also overwrites the day's `featured_combos` row, because lap
  validity is judged against the featured combo at ingestion time; closing the
  round restores whatever was there (`league_rounds.prior_featured_combo`, null
  meaning there was no row). Both halves are transactional - see
  `openLeagueRound` / `closeLeagueRound` in `apps/web/src/lib/league-queries.ts`.
- `league-round-lifecycle.test.ts` runs under plain `npm test` against a scratch
  database it builds from `db/migrations`, so it never touches Neon. How to point
  it, and when it skips versus hard-fails, is in the root README's
  [Integration tests](README.md#integration-tests) section.

## The live race feed

League night's race board reads `GET /api/race/live`, built from one row per
rig in `rig_race_status` that each agent replaces every 2-3 s
(`POST /api/agent/race-status`). The wire contract is `raceStatusEvent` in
`apps/web/src/lib/events.ts`; the agent, `scripts/fake-rig.ts --race` and that
schema change together, and [docs/live-race.md](docs/live-race.md) has the rest.
Three things are easy to undo. It stays off `/api/agent/events` and out of the
outbox, because a queued position is a wrong one. The upsert keeps the report
the rig's clock calls newest, so a late request cannot rewind a car, but any
report replaces a row that has gone stale (15 s), so a clock stepped back dims
the rig instead of freezing it until it ages off the board. Grouping,
ordering, staleness and intervals live only in `lib/race-live.ts`, and a board
numbers its rows by `place`, not `position`: a race under green is ordered by
how far round each car is, because iRacing's position only catches up with a
pass at the line; the grid and the finish keep iRacing's own order.

## Lap attribution

A lap belongs to whoever was in the seat when it was captured, not to whoever is
checked in when it arrives - the agent's outbox can hold a lap through a long
outage. So each queued lap carries the `rigAssignmentId` the agent had at
capture, and `/api/agent/events` attributes from that stamp and never from
whatever assignment is open when the batch arrives. The stamp is a candidate
the server still verifies, not a verdict - see the guards below - but it will
never substitute a different owner. Whether that assignment has since closed
is deliberately irrelevant.

The stamp has three states and the difference between them is load-bearing: a
uuid, an explicit `null` (nobody was checked in), and an **absent key** (an agent
too old to say). Never collapse the field to `.nullish()` or default it - absent
and null are different answers, and telling them apart is the whole
backward-compatibility story. The contract is documented on `lapCompletedEvent` in
`apps/web/src/lib/events.ts`; both ends of the wire change together, and the only
producers are `EventQueue.Enqueue` in the .NET agent and `scripts/fake-rig.ts`.

Three guards keep that stamp honest, and all are easy to delete by accident. On
the agent, a lap captured before any poll has ever succeeded is queued
*unresolved* - `PendingBatch` must never return one, because on the wire it
would be indistinguishable from "nobody was checked in". Also on the agent, an
assignment-poll answer that a local sign-out superseded while it was in flight
is dropped whole (the generation check in `AgentService`) - applying it would
resurrect the stint the driver just ended and stamp every later lap with it. On
the server, a lap only attaches to an assignment whose window contains its
`completedAt`, which the rig supplies; the clock-skew grace on that window is a
tolerance, not a policy knob.

A fourth guard sits in front of those three: pressing "switch driver" ends the
stint **locally first** and queues the checkout durably (`pending_checkout` in
the agent's SQLite outbox). Never gate that local clear on the backend's answer
- a backend the agent cannot reach then makes the button do nothing at all, and
the next person in the seat inherits the departed driver's stamp as valid,
ranking laps. The queued checkout names the assignment it is ending and
`POST /api/agent/checkout` closes only that one, because it is re-sent after an
outage, by which time the seat may legitimately belong to somebody else. That
stored id doubles as a tombstone: an assignment poll still reporting the stint
open must not reinstate it, which is what carries the guard across a rig PC
reboot. This does not close the case where the driver simply walks away without
pressing anything.

Laps the backend cannot attribute are STORED with a null `driver_id` and a null
`rig_assignment_id`, invalid with reason `UNATTRIBUTED`, and with
`unattributed_cause` saying which of the four causes it was, or `not_recorded`
when the writer recorded none - laps from before that column existed, and laps
a deployment older than it writes between migrate and deploy, which a
before-insert trigger fills so a database ahead of the code stays harmless
(`db/migrations/0004_unattributed_cause.sql`) - never credited to the next
driver, never dropped, and settled by the agent so an unattended rig cannot fill
its outbox. Unrankability is a database constraint, not a query convention:
`laps_unattributed_is_invalid` makes a valid ownerless lap unrepresentable and
`laps_unattributed_has_cause` makes an ownerless lap with no cause (or an owned
lap with one) unrepresentable, so do not add a `driver_id is not null` filter
to prove it - add a test that the constraint bites. `/staff` lists them under
*Unclaimed laps* with venue wording per cause; that wording, and the list the
database enum must match, live only in `apps/web/src/lib/unattributed-cause.ts`.
Attributing one to a driver is deliberately not built (see the SAFETY NOTE in
`db/migrations/0003_unattributed_laps.sql` before building it).

`lapTimeMs` is bounded at ingestion by `MAX_LAP_TIME_MS` in
`apps/web/src/lib/events.ts`, chosen from what a lap can be, with the reasoning
on the constant; do not re-derive it from a `/tv` column width, and do not
loosen it to make a rejected lap go away.

A lap the server refuses is the agent's problem to hold, not to retry. The body
is validated whole, so one bad lap 400s the whole batch; the agent reads the
zod issue paths, which name events by their POSITION in the batch, parks exactly
those rows in the outbox with the reason, and flushes the rest. Two halves of
that are load-bearing and easy to undo. A parked lap is **kept and never
re-sent** - the outbox holds the only copy there has ever been, and re-sending
it is the wedge (the rig went offline and re-sent the identical batch every five
seconds, holding every lap behind it). And only a refusal that **names events**
quarantines anything: a 401 from a rotated token or a proxy's error page is also
4xx and names no lap, so it still counts as unreachable and everything is
retried - quarantining on it would retire a whole venue's night over a config
change. Parked laps are counted and displayed apart from the queued ones, so the
rig's status line does not read the way it read while it was wedged.

## Rig heartbeats

Every `RIG_HEARTBEAT` is stored as a row in `rig_heartbeats`
(`db/migrations/0005_rig_heartbeats.sql`) for the rig monitor; `rigs.last_seen_at`
still moves, so nothing that reads `v_rig_status` changed. The contract is
`heartbeatEvent` in `apps/web/src/lib/events.ts`: v1 (`agentVersion` or nothing)
must keep working, so every v2 field stays optional, and its bounds are the
agent's to clamp to - the body is validated whole, so a heartbeat over one is
a 400 and the rig reads as silent. Clock skew is computed by the database
against the row's own `received_at`, never from a Vercel instance's clock. The
producers are the .NET agent and `scripts/fake-rig.ts`; change them with it.
A request carries at most one heartbeat and at most `MAX_EVENTS_BODY_BYTES`, and
a rig over six stored heartbeats a minute gets `rate_limited` (still 200, still
seen) - judged in the database so it holds across instances. Goodbyes
(`shuttingDown: true`) are exempt, always stored and never counted, because
they are what tells a clean exit from a power cut.
`v_rig_latest_heartbeat` is a per-rig `limit 1` lateral lookup on purpose: a
`distinct on` over the table reads all seven days of history every evaluation,
and an integration test counts the rows it reads.
`db/verify/0005_rig_heartbeats.sql` is the read-only fingerprint check the
owner runs after hand-applying; its pinned values are tested against the
migration, so update both together.

## Rig monitor

`apps/web/src/lib/monitor/` judges rigs from those rows and posts to Discord;
the runbook is [docs/monitoring.md](docs/monitoring.md). Every rule lives in
`rules.ts`, pure, and the staff Rig health page (`/staff/rigs`) calls the
same `evaluateRules` on the same snapshot and takes its tile colours from the
findings (`lib/monitor/rig-health.ts`) - do not write a second implementation
of a rule, the same discipline as `/tv` ranking. Its data-flow view
(`lib/monitor/flow.ts`) likewise only places findings, and a new rule does not
compile until `RULE_PLACE` gives it a place. The tile colours are the
owner's (2026-10-01): red is a problem, and it flashes only for an urgent
one, so a flash always means broken now; yellow is a running rig with nobody
signed in and green one with a driver, so a warning's text is orange there,
never gold. "Fires once, recovers once"
is enforced by `monitor_alerts_one_open` (`db/migrations/0006_monitor.sql`)
and single-statement transitions in `store.ts`, not by the throttle; only the
evaluation whose statement won posts. The `monitor_state` row lock the claim
takes is load-bearing too: it serializes evaluations, so an older snapshot is
never applied after a newer one (`store.ts` header). A rig's state is its
latest heartbeat *by send order* (`rigState`), never by arrival: an ordinary
heartbeat that lands after the goodbye it was sent before must not turn a
clean shutdown into a silent rig. There is no Vercel cron (Hobby runs one a
day): evaluation runs in `after()` on each heartbeat and on
`GET /api/monitor/tick`, which an outside clock calls with `CRON_SECRET`.
`scheduleMonitor` must never throw into the ingestion route - a 500 there
reads to the rig as the site being down. `db/verify/0006_monitor.sql` is one
SELECT with no transaction wrapper on purpose (Neon's SQL Editor shows only
the last statement's result); its pinned values are tested against the
migration, and a verify fingerprints only the columns its own migration
created, so a later `alter table` does not fail an earlier verify. A
fingerprint over a table's constraints filters `contype <> 'n'`: production
runs Postgres 18, which stores NOT NULL as constraint rows that 16 does not. An urgent alert's AI diagnosis, copy-paste handoff and rig-alert
GitHub issue (`diagnosis/`, `handoff.ts`, `github.ts`) are written from
`incidentContext`, an allowlist of what the server can vouch for - numbers,
flags, enum values, known agent notices as codes - that never carries a rig's
own strings (plan decision D9:
the free Gemini tier may train on prompts, and the handoff is pasted into a
coding harness and this public repository's issues). Do not add a rig string
to it behind a redaction regex; add a field of a vouchable kind, and keep
model text going through `modelText`. The rig is named there by
`rigs.rig_number`, never its staff-typed display name, which only the Discord
alert shows. One issue serves every alert of a rule within 24 hours, on any
rig - a software fault is venue-wide, and one bug must start one fix worker,
not twenty - while Discord stays per rig. Issue writes are serialized per rule
(`lockFault`) and carry a hidden marker (`rigAlertMarker`, naming the rule and
every alert the write covers) that a retry looks for before writing again,
trusted only as the last line of a write by the token's own account;
keep both on any new GitHub write. A rule that compares a rig with
today's combo uses ingestion's own `comboMismatch` (`validity.ts`), never a
second comparison. Bumping the agent's `AgentVersion` (`AgentConfig.cs`)
bumps `CURRENT_AGENT_VERSION` (`monitor/agent-version.ts`) in the same
commit - `agent-version.test.ts` fails otherwise - and from that deploy
every rig on the old build shows rule 11's warning until the exe is
replaced.

A `/tv` page opened from its signed staff link on `/staff` (the shop wall,
or the event board) heartbeats too (`components/tv/board-heartbeat.tsx`,
beside the engine, never inside it - `tv-screen.tsx` stays untouched), with a
ticket the page's server render signed (`lib/board-ticket.ts`): the route is
public and believes board, mode and host only from that ticket. The public
`/tv` and `/tv?event=1` get no ticket and report nothing - the owner's rule,
so no stranger can switch the channel into event mode or page him. Feed
health comes from wrapping each registered board type's `load` (`lib/tv-feed-health.ts`), not from the engine.
An event board heard within 3 minutes is event mode (`eventMode()` in
`monitor/event-mode.ts`, pure, shared like the rules); a dark one is rule 8a,
which is judged without event mode because the dark board no longer holds it.
Verify board-heartbeat changes with `npm run tv:heartbeat-check`.

## The twenty-rig soak

The venue has 20-25 sims and the platform had only ever been driven by one rig
at a time, so `apps/web/scripts/soak.ts` runs N concurrent `fake-rig.ts`
workers against a local production build and reconciles what they sent against
what the database holds. Runbook, the committed numbers, and - importantly -
what the run does NOT cover are in
[docs/soak-20-rigs.md](docs/soak-20-rigs.md); the machine-readable result is
`docs/soak-20-rigs.json`.

Three things about it are load-bearing. It reconciles **on event id, not a time
window**, so a re-run against the same database can neither inflate nor deflate
the count. Its two latency ceilings are the .NET agent's own flush interval and
HTTP timeout, not targets invented to be met - what a change actually gets
compared against is the committed JSON, which is why that file names the machine
it was produced on. And the load generator is the ordinary `fake-rig.ts` given
`--metrics`, deliberately not a second simulator, so the soak measures the same
client the demos run.

It needs a disposable database and refuses anything else: `SOAK_DATABASE_URL`
goes through the integration suite's `src/test/db-guard.ts`. Use a throwaway
Postgres, not the shared local `oasis-pg` - other lanes apply their own
migrations to that one.

Two files beside it are not the soak, and the split is deliberate. `soak.ts`
executes on import: it exports nothing, reads `process.argv` into module-level
constants and calls `main()` unguarded at the bottom, so importing it starts a
run (or the refusal). That is why anything in it that needs a unit test lives
in a pure module next to it - `scripts/soak-attribution.ts` reconciles who each
stored lap belongs to, `scripts/soak-lap-accounting.ts` decides what the summary
may claim about each lap - and both import nothing, which is what lets the
default `npm test` suite include them (`vitest.config.ts` records the same
reason). Folding either back into `soak.ts` leaves its tests with nothing to
import.

`scripts/soak-lap-accounting.test.ts` is a defect record, not a set of edge
cases. Its header names five defects that accounting really shipped, each
caught by someone reading a diff and none by a test until the suite existed.
They were fixed on PR #28's branch before it was squash-merged as `e742623` -
in the header's order `4a723e6`, `5010336`, `8c8fb03` finished by `2f7ea58`,
`67697ee` and `0122bb7` - hashes `main` does not reach, so look them up through
the pull request. The sixth of that family, a cross-rig landing credited to the
wrong driver (`ab557cb`), is the first case of `scripts/soak-attribution.test.ts`.
The header says why not to prune them as speculative; read it before agreeing.

## Staff sign-in refusals

Every refusal on `/staff/login` is worded in one place,
`apps/web/src/lib/staff-login-refusal.ts`, which also owns
`MIN_STAFF_PASSWORD_LENGTH`; the page renders whatever `staffLoginRefusal`
returns and the route answers with the codes it maps. Add a case by adding a
code there, not by branching in the page.

One of those cases must never become two. A wrong email and a wrong password
are answered identically, by the same code and the same message, so the form
gives nothing away about which addresses have staff accounts - turning it into
"no account with that email" is a regression, not a nicety, and
`route.test.ts` pins the pair as byte-identical. A malformed email address and
a too-short password are the cases that ARE safe to name, because both are
judged before any lookup and describe only what was typed.

Nothing enforces that minimum when a password is SET: Oasis creates staff
accounts and resets their passwords only by SQL, which is how a live account
came to hold a password the login route would always refuse.

## iRacing lap detection

The agent reads laps from iRacing's shared memory with
`OasisRigAgent.Core/Iracing/`: the spike recorder's parser ported (read-only
map, no package), a line scanner for the session-info YAML, and `LapDetector`,
a pure state machine over telemetry ticks. Detection rules and every skip
reason are documented on `LapDetector` and pinned by
`OasisRigAgent.Tests/Iracing/LapDetectorTests.cs`; change the rule and its
test together. Lap detection is verified against real iRacing on the owner's
rig with `OasisRigAgent.exe --diagnose` (reads and prints, posts nothing) on
2026-09-26 - the garage-exit resync test replays that log - but most trap
sequences are still hand-built from the SDK's documented behaviour, and a rig
posting to the hosted app is not yet verified. Run `--diagnose` first on any rig.

The featured combo matches lap strings exactly, so the agent prints the
`TrackDisplayName` / `TrackConfigName` / `CarScreenName` it posts on every lap
and the diagnostic prints the `featured_combos` SQL to paste; never type those
names from memory. `apps/web/scripts/manual-lap.ts` posts one lap by hand for
whoever is checked in on a rig, in the featured combo it reads from the app -
the fallback when a rig cannot read the sim.

## Walk-up check-in on the rig

With `rigQrToken` in its config the agent signs a typed name and 4-digit PIN
in through the backend's login, register and check-in routes as an HTTP
client with a cookie jar (`OasisRigAgent.Core/DriverCheckInClient.cs`), so a
returning driver keeps one row. Since 0.8-neon it first asks `GET /api/auth/name`
whether the name is taken - the one route the rig needs that the event-night
backends lacked - so verify request shapes against the served commit, not
only main.

The rig shows it as a WinForms window since 0.6, and console screens stay
behind `--console` as the window's fallback - not the backend's, since both
fronts ask the same routes. Both are thin fronts over
`OasisRigAgent.Core/WalkUp/`: the sign-in rules are `SignInFlow`
(one state machine, pinned by `SignInFlowTests` for both fronts - never write
a second one in a view), `WalkUpViewModel` is everything the window draws,
`TonightStanding` is the seated driver's place and best lap off the same
public tonight feed the wall polls (never a second ranking), and
`WalkUpRules` holds the warnings, log-out wording and seat-emptying. The
window's look is `Windows/Brand.cs`: colours named after the tokens in
`apps/web/src/app/globals.css`, Orbitron and Rajdhani embedded in the exe
(OFL, texts beside them) and registered process-private at first use - never
install a font on a rig, and never a web view. The owner's rules for it
(2026-10-02): an ordinary resizable window opened centred, never topmost or
full screen; name first, no "Raced here before?"; and nothing on a rig PC
that costs iRacing frames - the standing poll is one GET every 20 s off the
UI thread, stopped at log-out. Every screen has an HTML mockup with PNGs in
`docs/images/rig-window/`; update them with the form, since nothing can
screenshot the window off a rig. The host
project multi-targets: `net8.0` is the console build the tests run as a
process on macOS, `net8.0-windows` adds `OasisRigAgent/Windows/` and is what
the rig runs (publish with `-f net8.0-windows`); the window cannot run on a
Mac, so the checklist in the agent README (Verify the window on a rig) is the
check it gets. Exit work in the window host starts on the thread pool, never
the UI thread: an ordinary close awaits it and shows "Signing out...", but the
Windows-shutdown close waits for it synchronously (Windows owns that deadline),
and a UI-thread continuation would deadlock there. The exit sign-out also owns
a sign-in still in flight (`WalkUpViewModel.SignOutOnExitAsync`): it waits for
it out of the exit bound and either signs the stint out by id or records
`AgentService.UnknownStint`, the one unqualified checkout, for the next start.
Cancel the host's quit token after the exit work, never before.

In this mode the agent stamps laps only with a stint its own check-in created
in this process (`AgentService`), and every start ends whatever is open on
the rig before the name prompt; do not let the
poll adopt a stint again, or a restart credits the departed driver. Every
exit path in `Program.cs` signs out the seated driver durably and waits for
it, and sends nothing when nobody is seated (`SignOutSeatedDriverAsync`) - an
unnamed checkout would close whatever stint is open on the rig. The
console loop is `OasisRigAgent/DriverPrompt.cs`; the served-backend
test is `OasisRigAgent.Tests/NameLoopIntegrationTests.cs` (opt-in via
`OASIS_TEST_BACKEND_URL`).

A PIN chosen for a new name is typed twice before anything is registered, on
the rig and on the web's sign-up and guest "Save profile" forms
(`apps/web/src/lib/new-pin.ts`): a PIN mistyped once is one its owner can
never sign back in with, and only staff can fix it, with Reset PIN on
`/staff` (2026-09-28). The
rig looks the name up (`NameTakenAsync`, one bit) instead of guessing from
a failed login - that guess is what told chuy to use a different name - and
its sign-in is `SignInFlow` (above), over the client's separate
`CheckInReturningAsync` (login only) and `CheckInNewAsync` (register only).
The rules are documented on `SignInStep` and every sequence is a row of
`SignInFlowTests.EverySignInSequenceEndsWhereTheRulesSay`, so change a rule
and its row together. The load-bearing ones: a taken name never registers
and makes at most two failed logins per name for the whole sign-in - typing
the name again gets no fresh tries and no lookup - so a stranger cannot lock
the real driver out (the backend locks at five) from one sign-in; a free
name never logs in, and compares its two PINs on the rig; empty input after
the name goes back to it ("Not you?"). The website says the same in
`driver-auth-refusal.ts`.

## Rig heartbeat

`RIG_HEARTBEAT` is the rig's whole report to the server-side monitor:
`HeartbeatReport` (`apps/rig-agent/OasisRigAgent.Core/Heartbeat.cs`) mirrors
`heartbeatEvent` in `apps/web/src/lib/events.ts`, and both change together.
The owner's rule is that iRacing's frame rate comes first, so the agent runs
below normal priority (`Program.cs`), reports only state it already holds, and
every judgement stays on the server - do not add rig-side checks, threads or
timers for monitoring. Only the heartbeat backs off while offline; the poll
and flush carry laps and the sign-out and keep their intervals. Every exit
path sends a `shuttingDown` goodbye, or a closed rig reads as a dead one.
Walk-up sign-in failures are counted from the check-in routes' HTTP answers
(`SignInFailureWatch`), not inside `DriverCheckInClient`. The on-rig FPS check
is in `apps/rig-agent/README.md` (Heartbeat and footprint).

## Live race position

For the league-night race board each rig reports its own car every 2.5 s while
iRacing is in a session: `RaceStatusReport` (`OasisRigAgent.Core/RaceStatus.cs`)
mirrors `raceStatusEvent` in `apps/web/src/lib/events.ts`, and both change
together. The row is built only by the pure `RaceStatusSampler`
(`Iracing/RaceStatusSampler.cs`), which also nulls iRacing's sentinels and
clamps to the schema, since one field past it 400s the report and the car
leaves the board. Four rules are easy to undo: there is no outbox and no
retry (a dropped report is replaced by a fresh sample on the next interval,
and only a 404 or three failures in a row hold the rig back for
`RaceStatusReporter.FailureBackoff`, so one blip mid-race does not dim a car
and a site without the route is not polled every 2.5 s by every rig); the loop never touches the agent's
online/offline state; `raceStatus: false` in the config turns off both the
reads and the posts, and is the fallback rather than the old exe; and an
unchanged row still goes within `RaceStatusThrottle.KeepAlive`, under the
feed's 10 s ceiling, or a parked car dims. The `AgentService` change is one `RunLoop` and should stay that way.
What still needs a real rig in a hosted session is the checklist in
`apps/rig-agent/README.md` (Live race position).

## Local dev

- Building or testing `apps/rig-agent` needs the .NET SDK at `~/.dotnet`, which
  is not on the default PATH; the exact commands are in
  `apps/rig-agent/README.md` (Run from source).
  `.github/workflows/rig-agent.yml` builds both targets and runs the suite on
  Windows and Ubuntu for pull requests touching the agent; run it locally
  first anyway. The iRacing source only reads on Windows; on macOS
  `--diagnose` exits 3 and `"telemetry": "iracing"` fails at start-up, so run
  the agent here with `OASIS_TELEMETRY=simulated`.
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

## Migrations ship before code, and the build enforces it

`npm run build` (from `apps/web`) runs `scripts/check-migrations.ts` before
`next build`. How hard it is about a database it cannot vouch for - behind
`db/migrations`, unreachable, no `DATABASE_URL`, or `db/migrations` not visible
to the build - depends on where the build runs, and that decision is one pure
function, `gateMode` in `apps/web/scripts/migrations.ts`: a Vercel production
build **fails**, so Vercel rejects the deploy and the previous, schema-matching
deployment keeps serving the venue; a preview only **warns**, so a pull request
carrying a migration still produces a preview someone can open; a local build
fails when `DATABASE_URL` is set and skips when it is not. It never writes -
applying stays `npm run db:migrate`, run by a human. Both scripts print the
database they are pointed at as host/database before doing anything, which is
the only reliable answer to "which database is this" - an exported
`DATABASE_URL` beats `.env.local` and dotenv will not override it.

`npm run db:check` runs the check alone. `SKIP_MIGRATION_CHECK=1` (or `true`)
bypasses it and any other value is ignored with a warning; overriding Vercel's
Build Command to a bare `next build` bypasses it too.

It compares filenames against `schema_migrations`, not content, so it cannot
see a migration file edited after a database recorded it. The runbook for a
production database that is behind the code - including the object-existence
checks that do catch that case - is in
[docs/deploy.md](docs/deploy.md#recovering-a-database-that-is-behind-the-code).

## Local Kubernetes

`deploy/` holds a `kind` cluster, a two-target Dockerfile and Kustomize
manifests for the web app - development and demonstration only; production is
still Vercel plus Neon and the base manifests deliberately contain no database.
Everything, including why the rig agent is not containerized and why the image
build skips the migration gate, is in
[docs/platform/local-kubernetes.md](docs/platform/local-kubernetes.md). Run it
with `./deploy/local/oasis-kind.sh up`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
