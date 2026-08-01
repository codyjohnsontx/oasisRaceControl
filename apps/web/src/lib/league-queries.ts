import { isUniqueViolation, query, queryOne } from "./db";
import type { LeagueRound, LeagueSeason, RoundLap, RoundResult } from "./league";

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

type RawResult = Omit<RoundResult, "best_lap_at"> & { best_lap_at: Date | string | null };

/**
 * The ranked field for a set of rounds. One query serves both the round view
 * (`scope: "round"`) and season standings (`scope: "season"`) so the two can
 * never disagree about who finished where.
 *
 * The field is every entrant UNION every driver with an attributed lap, so a
 * driver is on the board whether they were entered at check-in or simply
 * started driving. Banned/flagged drivers are filtered out BEFORE ranking, so
 * they never occupy a position.
 */
async function queryRoundResults(
  scope: "round" | "season",
  id: string,
): Promise<RoundResult[]> {
  const scopeClause = scope === "round" ? "id = $1" : "season_id = $1";

  const rows = await query<RawResult>(
    `with r as (
       select id, round_number, coalesce(nullif(btrim(name), ''), 'Round ' || round_number) as round_name,
              to_char(round_date, 'YYYY-MM-DD') as round_date, closed_at
       from league_rounds
       where ${scopeClause}
     ),
     rl as (
       select l.* from v_league_round_laps l join r on r.id = l.round_id
     ),
     field as (
       select f.round_id, f.driver_id, d.display_name
       from (
         select e.round_id, e.driver_id
         from league_round_entries e
         join r on r.id = e.round_id
         union
         select rl.round_id, rl.driver_id from rl
       ) f
       join drivers d on d.id = f.driver_id and d.status = 'active'
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
     select r.id as round_id, r.round_number, r.round_name, r.round_date,
            (r.closed_at is not null) as closed,
            f.driver_id, f.display_name::text as display_name,
            c.lap_count, c.valid_lap_count,
            b.lap_time_ms as best_lap_ms, b.completed_at as best_lap_at,
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

  return rows.map((row) => ({
    ...row,
    best_lap_at: row.best_lap_at ? new Date(row.best_lap_at).toISOString() : null,
  }));
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
 * of the comparison view. Pass a driverId for a single driver's laps.
 *
 * The cap is a safety rail, not a product limit: a full league night at 25
 * rigs is a few hundred laps.
 */
export async function getRoundLaps(
  roundId: string,
  driverId?: string,
): Promise<RoundLap[]> {
  const rows = await query<Omit<RoundLap, "completed_at"> & { completed_at: Date | string }>(
    `select rl.lap_id as id, rl.driver_id, rl.lap_number, rl.lap_time_ms,
            rl.incident_delta, rl.is_valid, rl.invalid_reason, rl.completed_at
     from v_league_round_laps rl
     join drivers d on d.id = rl.driver_id and d.status = 'active'
     where rl.round_id = $1
       and ($2::uuid is null or rl.driver_id = $2::uuid)
     order by rl.completed_at asc, rl.lap_number asc nulls last, rl.lap_id asc
     limit 2000`,
    [roundId, driverId ?? null],
  );

  return rows.map((row) => ({
    ...row,
    completed_at: new Date(row.completed_at).toISOString(),
  }));
}

/**
 * Record that a driver took part in tonight's round, if this lap landed inside
 * an open round on that round's combo.
 *
 * Called from lap ingestion. Attribution itself does not depend on this row
 * (v_league_round_laps derives it from the lap) - the entry is what keeps a
 * driver in the field after every one of their laps is invalidated. Failure is
 * logged and swallowed: a missing participation row must never cost the venue
 * a lap.
 */
export async function recordLeagueEntry(
  driverId: string,
  lap: {
    trackName: string;
    trackConfig?: string | null;
    carName: string;
    completedAt: string;
  },
): Promise<void> {
  try {
    await query(
      `insert into league_round_entries (round_id, driver_id)
       select r.id, $1
       from league_rounds r
       where r.closed_at is null
         and $5::timestamptz >= r.opened_at
         and r.track_name = $2
         and coalesce(r.track_config, '') = coalesce($3, '')
         and r.car_name = $4
       on conflict do nothing`,
      [driverId, lap.trackName, lap.trackConfig ?? null, lap.carName, lap.completedAt],
    );
  } catch (error) {
    console.error("[league] entry insert failed", {
      driverId,
      message: (error as Error).message,
    });
  }
}

/**
 * The season new rounds land in, creating the league and season on first use.
 * Staff never have to set up a league before opening round one; renaming
 * either row afterwards is a normal update.
 */
export async function ensureOpenSeason(): Promise<LeagueSeason> {
  const existing = await getActiveSeason();
  if (existing) return existing;

  const league =
    (await queryOne<{ id: string; name: string }>(
      "select id, name from leagues order by created_at asc limit 1",
    )) ??
    (await queryOne<{ id: string; name: string }>(
      "insert into leagues (name) values ($1) returning id, name",
      ["Wednesday Night League"],
    ));
  if (!league) throw new Error("could not create a league");

  // Two staff opening the first round at once: one_open_season_per_league
  // makes the loser's insert fail, so re-read rather than duplicating.
  try {
    const season = await queryOne<{ id: string; name: string; started_on: string }>(
      `insert into league_seasons (league_id, name)
       values ($1, $2)
       returning id, name, to_char(started_on, 'YYYY-MM-DD') as started_on`,
      [league.id, "Season 1"],
    );
    if (!season) throw new Error("could not create a season");
    return {
      id: season.id,
      league_id: league.id,
      league_name: league.name,
      name: season.name,
      started_on: season.started_on,
      ended_on: null,
    };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await getActiveSeason();
    if (!raced) throw error;
    return raced;
  }
}
