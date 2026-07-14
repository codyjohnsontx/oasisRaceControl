import { query } from "./db";
import type { Board, BoardRow, BoardWindow } from "./leaderboards";

/**
 * Server-only leaderboard queries (imports pg). Kept separate from
 * leaderboards.ts so client components can import the shared types + pure
 * helpers without dragging the database driver into the browser bundle.
 */

/** Every track layout that has at least one valid lap from an active driver,
 *  with driver and lap counts. Joined to drivers so a track whose only laps
 *  belong to banned/flagged drivers doesn't show up as a pickable-but-empty
 *  board. Car isn't part of board identity — it's shown per row. */
export async function listBoards(): Promise<Board[]> {
  return query<Board>(
    `select l.track_name,
            l.track_config,
            count(distinct l.driver_id)::int as driver_count,
            count(*)::int                    as lap_count
     from laps l
     join drivers d on d.id = l.driver_id
     where l.is_valid and d.status = 'active'
     group by l.track_name, l.track_config
     order by l.track_name asc, coalesce(l.track_config, '') asc`,
  );
}

/**
 * One board: each active driver's single fastest valid lap for a combo, ranked
 * by time. `distinct on (driver_id)` picks each driver's best (inner order must
 * lead with driver_id), then the outer query re-sorts by time for the ranking.
 * Deterministic tiebreaks keep ranks stable between polls.
 *
 * Guests are included on purpose — the filter is status='active' only.
 */
export async function getBoard(
  track: string,
  config: string | null,
  window: BoardWindow,
  limit = 50,
): Promise<BoardRow[]> {
  // Tonight scopes to the venue-local date, single-sourced via venue_today().
  const tonightPredicate =
    window === "tonight"
      ? "and (l.completed_at at time zone 'America/Chicago')::date = venue_today()"
      : "";

  const rows = await query<Omit<BoardRow, "completed_at"> & { completed_at: Date | string }>(
    `select best.driver_id, best.display_name, best.lap_time_ms, best.car_name, best.completed_at
     from (
       select distinct on (l.driver_id)
         l.driver_id, d.display_name, l.lap_time_ms, l.car_name, l.completed_at
       from laps l
       join drivers d on d.id = l.driver_id
       where l.is_valid
         and d.status = 'active'
         and l.track_name = $1
         and coalesce(l.track_config, '') = coalesce($2, '')
         ${tonightPredicate}
       order by l.driver_id, l.lap_time_ms asc, l.completed_at asc, l.id asc
     ) best
     order by best.lap_time_ms asc, best.completed_at asc
     limit $3`,
    [track, config, limit],
  );

  // Normalize completed_at to ISO so the server page and JSON API agree (pg
  // hands back a Date; JSON would stringify it) — same as getDriverLaps.
  return rows.map((row) => ({
    ...row,
    completed_at: new Date(row.completed_at).toISOString(),
  }));
}
