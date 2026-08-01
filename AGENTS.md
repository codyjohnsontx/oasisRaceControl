# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## The `/tv` board rotation

`/tv` is an unattended wall display that cycles board types on a timer. Adding a
new kind of board (league standings, rig status) means writing one
`defineTvBoard` in `apps/web/src/components/tv/board-types.tsx`, registering it in
`TV_BOARD_TYPES`, and emitting its slides from `buildRotation` - do not modify the
rotation engine (`tv-screen.tsx`) or write a second ranking implementation. The
contract and the rules the engine guarantees are documented in
`apps/web/src/lib/tv-rotation.ts`.

Board data comes from the same public APIs `/leaderboards` uses, so the wall and
the phone agree by construction.

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
- Season points are one swappable module: `apps/web/src/lib/league-scoring.ts`.
  Nothing else in the codebase encodes a points table. The current default is
  documented at the top of that file and is pending the shop owner's confirmation.
- Opening a round also overwrites the day's `featured_combos` row, because lap
  validity is judged against the featured combo at ingestion time; closing the
  round restores whatever was there (`league_rounds.prior_featured_combo`, null
  meaning there was no row). Both halves are transactional - see
  `openLeagueRound` / `closeLeagueRound` in `apps/web/src/lib/league-queries.ts`.
- `league-round-lifecycle.test.ts` builds a scratch database from `db/migrations`
  and runs against it. It skips unless `DATABASE_URL` is local or
  `TEST_DATABASE_URL` is set, so it never touches Neon.

## Local dev

- `apps/web/.env.local` is gitignored and its comments have gone stale before.
  Read `DATABASE_URL` itself before assuming which database (local Docker
  `oasis-pg` on 5433, or Neon) a dev server or migration is pointed at.
- A local database that applied an earlier `0002_league_night.sql` reports
  `skip 0002_league_night.sql (already applied)` and then fails to open a round
  with `42703 undefined_column`. Drop and re-migrate it; the migration header
  (`db/migrations/0002_league_night.sql`) explains why.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
