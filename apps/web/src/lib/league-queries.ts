import type { PoolClient } from "pg";
import { query, queryOne, withTransaction } from "./db";
import { DRIVER_LAP_CAP, ROUND_LAP_CAP } from "./league";
import type { LeagueRound, LeagueSeason, RoundLap, RoundResult } from "./league";
import { venueMonthName } from "./venue";

/**
 * Server-only league queries (imports pg). Kept separate from league.ts so
 * client components can import the shared types and pure helpers without
 * dragging the database driver into the browser bundle.
 *
 * Every lap-facing query goes through v_league_round_laps, which owns the
 * attribution rule (a round owns the laps that landed in its open window on
 * its combo). Nothing here re-derives that predicate.
 */

const ROUND_COLUMNS = `r.id, r.season_id, s.name as season_name, lg.name as league_name,
  r.round_number, r.name, to_char(r.round_date, 'YYYY-MM-DD') as round_date,
  r.track_name, r.track_config, r.car_name, r.incident_limit,
  r.opened_at, r.closed_at`;

const ROUND_FROM = `from league_rounds r
  join league_seasons s on s.id = r.season_id
  join leagues lg on lg.id = s.league_id`;

type RawRound = Omit<LeagueRound, "opened_at" | "closed_at"> & {
  opened_at: Date | string;
  closed_at: Date | string | null;
};

function normalizeRound(row: RawRound): LeagueRound {
  return {
    ...row,
    opened_at: new Date(row.opened_at).toISOString(),
    closed_at: row.closed_at ? new Date(row.closed_at).toISOString() : null,
  };
}

/** Tonight's round, if staff have one open. At most one exists venue-wide
 *  (enforced by the one_open_round_venue_wide index). */
export async function getOpenRound(): Promise<LeagueRound | null> {
  const row = await queryOne<RawRound>(
    `select ${ROUND_COLUMNS} ${ROUND_FROM} where r.closed_at is null`,
  );
  return row ? normalizeRound(row) : null;
}

export async function getRound(roundId: string): Promise<LeagueRound | null> {
  const row = await queryOne<RawRound>(
    `select ${ROUND_COLUMNS} ${ROUND_FROM} where r.id = $1`,
    [roundId],
  );
  return row ? normalizeRound(row) : null;
}

/** The season currently running (the one league's open season), or null before
 *  staff have ever opened a round. */
export async function getActiveSeason(): Promise<LeagueSeason | null> {
  return queryOne<LeagueSeason>(
    `select s.id, s.league_id, lg.name as league_name, s.name,
            to_char(s.started_on, 'YYYY-MM-DD') as started_on,
            to_char(s.ended_on, 'YYYY-MM-DD') as ended_on
     from league_seasons s
     join leagues lg on lg.id = s.league_id
     where s.ended_on is null
     order by s.started_on desc, s.created_at desc
     limit 1`,
  );
}

export async function getSeason(seasonId: string): Promise<LeagueSeason | null> {
  return queryOne<LeagueSeason>(
    `select s.id, s.league_id, lg.name as league_name, s.name,
            to_char(s.started_on, 'YYYY-MM-DD') as started_on,
            to_char(s.ended_on, 'YYYY-MM-DD') as ended_on
     from league_seasons s
     join leagues lg on lg.id = s.league_id
     where s.id = $1`,
    [seasonId],
  );
}

/** A season's rounds, newest first (that is the order the standings page and
 *  the staff panel both want). */
export async function listSeasonRounds(seasonId: string): Promise<LeagueRound[]> {
  const rows = await query<RawRound>(
    `select ${ROUND_COLUMNS} ${ROUND_FROM}
     where r.season_id = $1
     order by r.round_number desc`,
    [seasonId],
  );
  return rows.map(normalizeRound);
}

/**
 * The ranked field for a set of rounds. One query serves both the round view
 * (`scope: "round"`) and season standings (`scope: "season"`) so the two can
 * never disagree about who finished where.
 *
 * The field is every driver with a lap attributed to the round. Attribution
 * ignores validity, so a driver who binned every lap is still on the board
 * with position null. Banned/flagged drivers are filtered out BEFORE ranking,
 * so they never occupy a position.
 */
async function queryRoundResults(
  scope: "round" | "season",
  id: string,
): Promise<RoundResult[]> {
  const scopeClause = scope === "round" ? "id = $1" : "season_id = $1";

  return query<RoundResult>(
    `with r as (
       select id, round_number from league_rounds where ${scopeClause}
     ),
     rl as (
       select l.* from v_league_round_laps l join r on r.id = l.round_id
     ),
     field as (
       select distinct rl.round_id, rl.driver_id, d.display_name
       from rl
       join drivers d on d.id = rl.driver_id and d.status = 'active'
     ),
     counts as (
       select f.round_id, f.driver_id,
              count(rl.lap_id)::int as lap_count,
              (count(rl.lap_id) filter (where rl.is_valid))::int as valid_lap_count
       from field f
       left join rl on rl.round_id = f.round_id and rl.driver_id = f.driver_id
       group by f.round_id, f.driver_id
     ),
     best as (
       select distinct on (rl.round_id, rl.driver_id)
         rl.round_id, rl.driver_id, rl.lap_time_ms, rl.completed_at
       from rl
       where rl.is_valid
       order by rl.round_id, rl.driver_id, rl.lap_time_ms asc, rl.completed_at asc, rl.lap_id asc
     )
     select r.id as round_id, r.round_number,
            f.driver_id, f.display_name::text as display_name,
            c.lap_count, c.valid_lap_count,
            b.lap_time_ms as best_lap_ms,
            case when b.lap_time_ms is null then null else
              row_number() over (
                partition by f.round_id
                order by b.lap_time_ms asc nulls last, b.completed_at asc, f.display_name asc
              )::int
            end as position
     from field f
     join r on r.id = f.round_id
     join counts c on c.round_id = f.round_id and c.driver_id = f.driver_id
     left join best b on b.round_id = f.round_id and b.driver_id = f.driver_id
     order by r.round_number asc, position asc nulls last, f.display_name asc`,
    [id],
  );
}

/** One round's full field, ranked by best valid lap. Drivers with no valid lap
 *  come last with position null. */
export function getRoundField(roundId: string): Promise<RoundResult[]> {
  return queryRoundResults("round", roundId);
}

/** Every round result in a season - the input to computeSeasonStandings(). */
export function getSeasonRoundResults(seasonId: string): Promise<RoundResult[]> {
  return queryRoundResults("season", seasonId);
}

/**
 * Laps attributed to a round, oldest first (the order they were driven).
 * Invalid laps are included - seeing which laps were binned is half the point
 * of the comparison view. Pass driverIds to fetch just those drivers' laps;
 * one call covers every expanded row on the round page.
 *
 * The cap is a safety rail, but a reachable one: 25 rigs running two-minute
 * laps for a four-hour evening is roughly 3000 laps. So the query asks for one
 * row past the cap and reports whether it hit it - a comparison view that
 * quietly drops a driver's laps would be worse than one that says it is
 * showing a subset.
 *
 * A request that names drivers budgets rows PER DRIVER (DRIVER_LAP_CAP), which
 * is why the cap is applied through a per-driver row_number rather than a plain
 * limit. One budget shared across the named set is spent in `completed_at`
 * order, so on a long night the drivers still running come back with a short
 * list or none at all - exactly the silent short-list this cap exists to
 * prevent, and the round page's poll asks for every expanded row at once. The
 * unfiltered call keeps one round-wide budget, because it renders the whole
 * round into a single page.
 */
export async function getRoundLaps(
  roundId: string,
  driverIds?: string[],
): Promise<{ laps: RoundLap[]; truncated: boolean }> {
  const perDriverCap = driverIds ? DRIVER_LAP_CAP : ROUND_LAP_CAP;
  const overallCap = driverIds ? driverIds.length * DRIVER_LAP_CAP : ROUND_LAP_CAP;

  const rows = await query<Omit<RoundLap, "completed_at"> & { completed_at: Date | string }>(
    `with attributed as (
       select rl.lap_id as id, rl.driver_id, rl.lap_number, rl.lap_time_ms,
              rl.incident_delta, rl.is_valid, rl.invalid_reason, rl.completed_at,
              row_number() over (
                partition by rl.driver_id
                order by rl.completed_at asc, rl.lap_number asc nulls last, rl.lap_id asc
              ) as driver_lap_rank
       from v_league_round_laps rl
       join drivers d on d.id = rl.driver_id and d.status = 'active'
       where rl.round_id = $1
         and ($2::uuid[] is null or rl.driver_id = any ($2::uuid[]))
     )
     select id, driver_id, lap_number, lap_time_ms, incident_delta, is_valid,
            invalid_reason, completed_at
     from attributed
     where driver_lap_rank <= $3
     order by completed_at asc, lap_number asc nulls last, id asc
     limit $4`,
    [roundId, driverIds ?? null, perDriverCap, overallCap + 1],
  );

  const perDriver = new Map<string, number>();
  for (const row of rows) {
    perDriver.set(row.driver_id, (perDriver.get(row.driver_id) ?? 0) + 1);
  }
  // Either budget running out means what came back is a subset of what was
  // asked for, so say so rather than letting a caller treat a prefix as whole.
  const truncated =
    rows.length > overallCap ||
    [...perDriver.values()].some((count) => count >= perDriverCap);

  return {
    laps: rows.slice(0, overallCap).map((row) => ({
      ...row,
      completed_at: new Date(row.completed_at).toISOString(),
    })),
    truncated,
  };
}

/** How many drivers are in a round's field. Same rule as getRoundField, without
 *  paying for the ranking - the staff dashboard only shows the number. */
export async function countRoundDrivers(roundId: string): Promise<number> {
  const row = await queryOne<{ drivers: number }>(
    `select count(distinct rl.driver_id)::int as drivers
     from v_league_round_laps rl
     join drivers d on d.id = rl.driver_id and d.status = 'active'
     where rl.round_id = $1`,
    [roundId],
  );
  return row?.drivers ?? 0;
}

/** The featured combo a round found in place before it pinned its own, as
 *  stored in league_rounds.prior_featured_combo. */
type PriorFeaturedCombo = {
  track_name: string;
  track_config: string | null;
  car_name: string;
  incident_limit: number;
};

const FEATURED_COMBO_UPSERT = `insert into featured_combos
    (combo_date, track_name, track_config, car_name, incident_limit)
  values ($1::date, $2, $3, $4, $5)
  on conflict (combo_date) do update
    set track_name = excluded.track_name,
        track_config = excluded.track_config,
        car_name = excluded.car_name,
        incident_limit = excluded.incident_limit`;

/**
 * The season new rounds land in, creating the league and season on first use.
 * Staff never have to set up a league before opening round one; renaming
 * either row afterwards is a normal update.
 *
 * Runs on the caller's transaction, which is what makes the concurrent
 * first-open safe: two staff opening round one at the same moment each build a
 * league and a season, then collide on one_open_round_venue_wide when they
 * insert the round. The loser's whole transaction rolls back, so it leaves no
 * orphan league or season behind for getActiveSeason() to find later.
 */
async function ensureOpenSeasonTx(client: PoolClient): Promise<{ id: string }> {
  const open = await client.query<{ id: string }>(
    `select id from league_seasons where ended_on is null
     order by started_on desc, created_at desc limit 1`,
  );
  if (open.rows[0]) return open.rows[0];

  const league = await client.query<{ id: string }>(
    "select id from leagues order by created_at asc limit 1",
  );
  const leagueId =
    league.rows[0]?.id ??
    (
      await client.query<{ id: string }>(
        "insert into leagues (name) values ($1) returning id",
        ["Wednesday Night League"],
      )
    ).rows[0].id;

  const season = await client.query<{ id: string }>(
    "insert into league_seasons (league_id, name) values ($1, $2) returning id",
    [leagueId, venueMonthName()],
  );
  return season.rows[0];
}

/**
 * End the season that is running and start the next one, in one transaction so
 * the venue is never left with no open season for rounds to land in.
 *
 * A season is a calendar month, so this is a routine monthly job for whoever is
 * on shift, not a DBA operation - but the trigger stays explicitly human. The
 * name is the only thing derived from the calendar; nothing rolls a season over
 * on a date boundary by itself.
 *
 * Refuses while a round is open rather than orphaning tonight's round in a
 * season the standings no longer show.
 */
export async function rollLeagueSeason(): Promise<
  | { status: "rolled"; endedSeasonId: string; endedSeasonName: string; seasonId: string; seasonName: string }
  | { status: "round_open"; roundId: string }
  | { status: "no_season" }
> {
  return withTransaction(async (client) => {
    // Locked before anything is written, so a double-tap on the venue tablet
    // ends one season rather than ending the replacement it just created: the
    // second transaction re-checks `ended_on is null` after taking the lock and
    // comes back empty.
    const current = await client.query<{ id: string; league_id: string; name: string }>(
      `select id, league_id, name from league_seasons
       where ended_on is null
       order by started_on desc, created_at desc
       limit 1
       for update`,
    );
    const season = current.rows[0];
    if (!season) return { status: "no_season" as const };

    const open = await client.query<{ id: string }>(
      "select id from league_rounds where closed_at is null limit 1",
    );
    if (open.rows[0]) {
      return { status: "round_open" as const, roundId: open.rows[0].id };
    }

    await client.query(
      "update league_seasons set ended_on = venue_today() where id = $1",
      [season.id],
    );

    const next = await client.query<{ id: string; name: string }>(
      "insert into league_seasons (league_id, name) values ($1, $2) returning id, name",
      [season.league_id, venueMonthName()],
    );

    return {
      status: "rolled" as const,
      endedSeasonId: season.id,
      endedSeasonName: season.name,
      seasonId: next.rows[0].id,
      seasonName: next.rows[0].name,
    };
  });
}

/**
 * Open tonight's round, in one transaction: the season it belongs to, the
 * round itself, the snapshot of the featured combo it is about to overwrite,
 * and the overwrite. Either the round exists with its combo pinned or nothing
 * happened - a half-open round would ingest the whole night's laps as
 * WRONG_CAR while the 409 guard blocked staff from reopening it.
 */
export async function openLeagueRound(input: {
  name: string | null;
  trackName: string;
  trackConfig: string | null;
  carName: string;
  incidentLimit: number;
}): Promise<{ id: string; roundNumber: number; seasonId: string }> {
  return withTransaction(async (client) => {
    const season = await ensureOpenSeasonTx(client);

    const inserted = await client.query<{
      id: string;
      round_number: number;
      round_date: string;
    }>(
      `insert into league_rounds
         (season_id, round_number, name, track_name, track_config, car_name,
          incident_limit, prior_featured_combo)
       select $1,
              coalesce(max(round_number), 0) + 1,
              $2, $3, $4, $5, $6,
              (select to_jsonb(prior)
               from (select track_name, track_config, car_name, incident_limit
                     from featured_combos where combo_date = venue_today()) prior)
       from league_rounds where season_id = $1
       returning id, round_number, to_char(round_date, 'YYYY-MM-DD') as round_date`,
      [
        season.id,
        input.name,
        input.trackName,
        input.trackConfig,
        input.carName,
        input.incidentLimit,
      ],
    );
    const round = inserted.rows[0];

    // round_date defaults to venue_today(), the same date the snapshot above
    // read, so the round overwrites and later restores one row.
    await client.query(FEATURED_COMBO_UPSERT, [
      round.round_date,
      input.trackName,
      input.trackConfig,
      input.carName,
      input.incidentLimit,
    ]);

    return { id: round.id, roundNumber: round.round_number, seasonId: season.id };
  });
}

/**
 * Close a round and put the featured combo back the way opening it found it -
 * restoring the venue's own combo if it had one, deleting the row if it had
 * none. Without this the round's combo stays pinned for the rest of the venue
 * day and every ordinary customer lap on other content is stored invalid and
 * drops off Fastest Tonight.
 *
 * Both halves share one transaction: a round whose combo was not restored
 * would be final with no control left to undo it. Returns null when the round
 * is already closed or unknown.
 */
export async function closeLeagueRound(roundId: string): Promise<{
  id: string;
  roundNumber: number;
  restoredCombo: PriorFeaturedCombo | null;
} | null> {
  return withTransaction(async (client) => {
    const closed = await client.query<{
      id: string;
      round_number: number;
      round_date: string;
      prior_featured_combo: PriorFeaturedCombo | null;
    }>(
      `update league_rounds set closed_at = now()
       where id = $1 and closed_at is null
       returning id, round_number, to_char(round_date, 'YYYY-MM-DD') as round_date,
                 prior_featured_combo`,
      [roundId],
    );
    const round = closed.rows[0];
    if (!round) return null;

    const prior = round.prior_featured_combo;
    if (prior) {
      await client.query(FEATURED_COMBO_UPSERT, [
        round.round_date,
        prior.track_name,
        prior.track_config,
        prior.car_name,
        prior.incident_limit,
      ]);
    } else {
      await client.query("delete from featured_combos where combo_date = $1::date", [
        round.round_date,
      ]);
    }

    return {
      id: round.id,
      roundNumber: round.round_number,
      restoredCombo: prior,
    };
  });
}
