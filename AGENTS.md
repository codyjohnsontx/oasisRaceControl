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
- Opening a round also overwrites the day's `featured_combos` row, because lap
  validity is judged against the featured combo at ingestion time; closing the
  round restores whatever was there (`league_rounds.prior_featured_combo`, null
  meaning there was no row). Both halves are transactional - see
  `openLeagueRound` / `closeLeagueRound` in `apps/web/src/lib/league-queries.ts`.
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
(`reviews.auto_review.auto_incremental_review`). So `@coderabbitai review` has to
be requested before merging any pull request that gained commits after it opened.
Nothing in this repository enforces that, and skipping it merges those later
commits - usually the fix rounds - unreviewed.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
