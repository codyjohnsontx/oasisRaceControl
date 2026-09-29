import { afterAll, beforeEach, expect, it } from "vitest";
import { GET } from "./route";
import {
  closeTestDb,
  describeDb,
  openAssignment,
  resetDb,
  seedDriver,
  seedRig,
  setFeaturedCombo,
  testDb,
} from "@/test/db";

/**
 * The wall marks a time that had an off-track by the incident count of the lap
 * it shows. `v_fastest_tonight` does not carry that count, so the route reads
 * it back off `laps`; these cases pin that it is the shown lap's count and not
 * another lap's by the same driver.
 */

const TRACK = "Spa-Francorchamps";
const CAR = "Porsche 911 GT3 R";

async function seedLap(
  rigId: string,
  assignmentId: string,
  driverId: string,
  lap: { lapTimeMs: number; incidents: number; minutesAgo: number },
): Promise<void> {
  await testDb().query(
    `insert into laps (event_id, rig_id, rig_assignment_id, driver_id,
                       track_name, car_name, lap_time_ms, incident_delta,
                       is_valid, completed_at)
     values ('evt-' || gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, true,
             now() - ($8 || ' minutes')::interval)`,
    [rigId, assignmentId, driverId, TRACK, CAR, lap.lapTimeMs, lap.incidents, lap.minutesAgo],
  );
}

describeDb("GET /api/leaderboard/tonight", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("carries the incident count of each driver's shown lap, not of their other laps", async () => {
    await setFeaturedCombo({ trackName: TRACK, carName: CAR, incidentLimit: 4 });
    const rig = await seedRig(1);
    const otherRig = await seedRig(2);
    const offTrack = await seedDriver("Off Track");
    const clean = await seedDriver("Clean");
    const offTrackStint = await openAssignment(rig.id, offTrack.id);
    await seedLap(rig.id, offTrackStint, offTrack.id, { lapTimeMs: 90_000, incidents: 2, minutesAgo: 3 });
    await seedLap(rig.id, offTrackStint, offTrack.id, { lapTimeMs: 91_000, incidents: 0, minutesAgo: 2 });
    const cleanStint = await openAssignment(otherRig.id, clean.id);
    await seedLap(otherRig.id, cleanStint, clean.id, { lapTimeMs: 92_000, incidents: 0, minutesAgo: 1 });
    await seedLap(otherRig.id, cleanStint, clean.id, { lapTimeMs: 93_000, incidents: 3, minutesAgo: 0 });

    const res = await GET(new Request("http://tv.local/api/leaderboard/tonight"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(
      body.rows.map((row: { display_name: string; lap_time_ms: number; incident_delta: number | null }) => [
        row.display_name,
        row.lap_time_ms,
        row.incident_delta,
      ]),
    ).toEqual([
      ["Off Track", 90_000, 2],
      ["Clean", 92_000, 0],
    ]);
  });

  // The event view promises every driver of the day. It used to ask for a
  // ceiling of 200 rows, and the 201st driver vanished while the board still
  // read "200 drivers" - so the count here is deliberately past that.
  it("returns every driver of the day for limit=all", async () => {
    await setFeaturedCombo({ trackName: TRACK, carName: CAR });
    const rig = await seedRig(1);
    const drivers = 250;
    await testDb().query(
      `with d as (
         insert into drivers (display_name, is_guest)
         select 'Driver ' || lpad(n::text, 3, '0'), true from generate_series(1, $1) n
         returning id, display_name
       ), a as (
         insert into rig_assignments (rig_id, driver_id, ended_at, end_reason)
         select $2, id, now(), 'driver_ended' from d
         returning id, driver_id
       )
       insert into laps (event_id, rig_id, rig_assignment_id, driver_id,
                         track_name, car_name, lap_time_ms, incident_delta,
                         is_valid, completed_at)
       select 'evt-' || gen_random_uuid(), $2, a.id, a.driver_id, $3, $4,
              100000 + substring(d.display_name from 8)::int, 0, true, now()
       from a join d on d.id = a.driver_id`,
      [drivers, rig.id, TRACK, CAR],
    );

    const res = await GET(new Request("http://tv.local/api/leaderboard/tonight?limit=all"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.rows).toHaveLength(drivers);
    expect(body.rows.at(-1).display_name).toBe("Driver 250");
  });
});
