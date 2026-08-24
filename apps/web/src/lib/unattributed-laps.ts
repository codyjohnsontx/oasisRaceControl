import { query } from "@/lib/db";

/** A lap the system could not credit to anyone. `attributeLap`
 *  (`app/api/agent/events/route.ts`) puts a lap here for four different
 *  reasons - nobody was checked in, the rig's agent is too old to say who was,
 *  the assignment it names does not belong to that rig, or its `completedAt`
 *  falls outside that assignment's window. The row carries no cause: it
 *  survives only in the server log line for the batch. Stored, invalid and
 *  unrankable - it has no driver, so there is nothing to reset a PIN on and no
 *  validity to argue about. */
export type UnattributedLapRow = {
  id: string;
  lap_time_ms: number;
  track_name: string;
  track_config: string | null;
  car_name: string;
  completed_at: string;
  rig_number: number | null;
};

export type UnattributedLaps = {
  laps: UnattributedLapRow[];
  /** Unclaimed laps in the whole window, not just the page of them above.
   *  `/staff` is the only surface that opens this bucket, so a list silently
   *  cut off at the cap would hide exactly the laps somebody came looking for. */
  total: number;
};

/** Deliberately modest: this is a diagnostic list read at a counter, not an
 *  archive. `total` is what tells a reader the window holds more. */
const UNATTRIBUTED_LAP_LIMIT = 30;

/** The window the list covers. Staff use it to answer "where did my laps go"
 *  about a visit, not to audit the season. */
const UNATTRIBUTED_LAP_WINDOW = "7 days";

/**
 * The last {@link UNATTRIBUTED_LAP_WINDOW} of unclaimed laps, plus how many the
 * window actually holds.
 *
 * One query, so the count and the list can never disagree: `count(*) over ()`
 * is evaluated over the full filtered set before `limit` cuts it, which means
 * the total is by construction the same predicate and the same window as the
 * rows it labels. A second counting query would be free to drift from this one,
 * and a count that does not match the list it labels is worse than no count -
 * it looks precise.
 */
export async function listUnattributedLaps(): Promise<UnattributedLaps> {
  const rows = await query<UnattributedLapRow & { total_count: number }>(
    `select l.id, l.lap_time_ms, l.track_name, l.track_config, l.car_name,
            l.completed_at, r.rig_number,
            (count(*) over ())::int as total_count
     from laps l
     join rigs r on r.id = l.rig_id
     where l.driver_id is null
       and l.completed_at > now() - $1::interval
     order by l.completed_at desc
     limit $2`,
    [UNATTRIBUTED_LAP_WINDOW, UNATTRIBUTED_LAP_LIMIT],
  );

  return { laps: rows, total: rows[0]?.total_count ?? 0 };
}
