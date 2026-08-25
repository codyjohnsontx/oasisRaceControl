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
  is the sum of every round entered - no drops, no bonus points.
- Opening a round also overwrites the day's `featured_combos` row, because lap
  validity is judged against the featured combo at ingestion time; closing the
  round restores whatever was there (`league_rounds.prior_featured_combo`, null
  meaning there was no row). Both halves are transactional - see
  `openLeagueRound` / `closeLeagueRound` in `apps/web/src/lib/league-queries.ts`.
- `league-round-lifecycle.test.ts` runs under plain `npm test` against a scratch
  database it builds from `db/migrations`, so it never touches Neon. How to point
  it, and when it skips versus hard-fails, is in the root README's
  [Integration tests](README.md#integration-tests) section.

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
`unattributed_cause` saying which of the four causes it was
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
on the constant; do not re-derive it from a `/tv` column width. A batch the
server rejects with a 400 is a known agent-side wedge: the agent cannot tell it
from the network being down and re-sends the same batch every flush, so one
rejected lap holds every lap behind it. The mechanism and the follow-up
(`oasis-agent-quarantine-rejected-events`) are in `docs/plan.md`'s failure
list; do not fix it by loosening the server bound.

## Local dev

- Building or testing `apps/rig-agent` needs the .NET SDK at `~/.dotnet`, which
  is not on the default PATH; the exact commands are in
  `apps/rig-agent/README.md` (Run from source). No CI workflow builds the agent
  (`spike-safety.yml` covers `spike/` only), so that local run is the only
  check it gets.
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
