import { afterAll, beforeEach, expect, it } from "vitest";
import { LIVE_TRACK_WINDOW_MINUTES } from "./leaderboards";
import { listBoards, listLiveTracks } from "./leaderboards-queries";
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
 * Live tracks against real Postgres: a track a rig reports in its heartbeat
 * is listed with no lap on it, stays listed while any rig has reported it
 * inside the live window, and is gone once the last report ages past it. The
 * tracks with laps are read by `listBoards()` exactly as before - a heartbeat
 * cannot add or remove one, and a lap on a track a rig is on changes nothing
 * about the live list, since `buildRotation` keeps that track on its laps
 * (`components/tv/board-types.test.tsx`). On a day with a featured combo,
 * only a rig in that combo puts its track on the list.
 */

const monza = { track: "Monza", config: "Grand Prix", car: "BMW M4 GT3" };

/** Stores a heartbeat as the ingestion route does, `ago` minutes back. */
async function heartbeat(
  rigId: string,
  session: { track: string; config: string | null; car: string } | null,
  ago = 0,
  shuttingDown = false,
) {
  await testDb().query(
    `insert into rig_heartbeats
       (rig_id, received_at, session_track, session_config, session_car, shutting_down)
     values ($1, now() - make_interval(mins => $2), $3, $4, $5, $6)`,
    [rigId, ago, session?.track ?? null, session?.config ?? null, session?.car ?? null, shuttingDown],
  );
}

/** Stores one valid lap on a combo for a driver seated on the rig. */
async function lap(rigId: string, combo: { track: string; config: string | null; car: string }) {
  const driver = await seedDriver(`Driver ${Math.random().toString(36).slice(2, 8)}`);
  const assignment = await openAssignment(rigId, driver.id);
  await testDb().query(
    `insert into laps (event_id, rig_id, rig_assignment_id, driver_id, track_name, track_config,
                       car_name, lap_time_ms, is_valid, completed_at)
     values ($1, $2, $3, $4, $5, $6, $7, 100000, true, now())`,
    [`lap-${driver.id}`, rigId, assignment, driver.id, combo.track, combo.config, combo.car],
  );
}

describeDb("listLiveTracks against real Postgres", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("lists a track a rig reported with no lap on it, with its cars and rig count", async () => {
    const rig1 = await seedRig(1);
    const rig2 = await seedRig(2);
    await heartbeat(rig1.id, monza, 3);
    await heartbeat(rig1.id, monza);
    await heartbeat(rig2.id, { ...monza, car: "Porsche 911 GT3 R" });
    // A rig idle at the menu reports no session and adds no track.
    const idle = await seedRig(3);
    await heartbeat(idle.id, null);

    expect(await listLiveTracks()).toEqual([
      { track_name: "Monza", track_config: "Grand Prix", car_names: ["BMW M4 GT3", "Porsche 911 GT3 R"], rig_count: 2 },
    ]);
    // Nothing has lapped it, so the phone's picker and the wall's lapped
    // boards still do not know it.
    expect(await listBoards()).toEqual([]);
  });

  it("drops a track once no rig has reported it inside the live window", async () => {
    const rig = await seedRig(1);
    await heartbeat(rig.id, monza, LIVE_TRACK_WINDOW_MINUTES + 1);
    expect(await listLiveTracks()).toEqual([]);

    // One report just inside the window, from any rig, keeps it.
    const other = await seedRig(2);
    await heartbeat(other.id, monza, LIVE_TRACK_WINDOW_MINUTES - 1);
    expect((await listLiveTracks()).map((t) => t.track_name)).toEqual(["Monza"]);
  });

  it("orders by track then layout, and keeps a layout apart from the bare track", async () => {
    const rig = await seedRig(1);
    await heartbeat(rig.id, { track: "Spa-Francorchamps", config: null, car: "Ferrari 296 GT3" }, 2);
    await heartbeat(rig.id, { track: "Spa-Francorchamps", config: "Endurance", car: "Ferrari 296 GT3" }, 1);
    await heartbeat(rig.id, monza);

    expect((await listLiveTracks()).map((t) => [t.track_name, t.track_config])).toEqual([
      ["Monza", "Grand Prix"],
      ["Spa-Francorchamps", null],
      ["Spa-Francorchamps", "Endurance"],
    ]);
  });

  it("leaves the lapped boards to the laps: a heartbeat adds none and a lap removes none", async () => {
    const rig = await seedRig(1);
    await lap(rig.id, monza);
    const before = await listBoards();
    expect(before.map((b) => b.track_name)).toEqual(["Monza"]);

    await heartbeat(rig.id, monza);
    await heartbeat(rig.id, { track: "Okayama", config: null, car: "Mazda MX-5" });
    expect(await listBoards()).toEqual(before);
    // Both are live; the rotation builder is what keeps Monza on its laps.
    expect((await listLiveTracks()).map((t) => t.track_name)).toEqual(["Monza", "Okayama"]);
  });

  it("counts a goodbye as a report too: the rig was on the track when it left", async () => {
    const rig = await seedRig(1);
    await heartbeat(rig.id, monza, 1, true);
    expect((await listLiveTracks()).map((t) => t.rig_count)).toEqual([1]);
  });

  it("on a featured-combo day lists only the combo, whatever else the rigs are on", async () => {
    await setFeaturedCombo({ trackName: monza.track, trackConfig: monza.config, carName: monza.car });
    const rig1 = await seedRig(1);
    const rig2 = await seedRig(2);
    const rig3 = await seedRig(3);
    await heartbeat(rig1.id, monza);
    await heartbeat(rig2.id, { ...monza, car: "Porsche 911 GT3 R" });
    await heartbeat(rig3.id, { track: "Spa-Francorchamps", config: null, car: monza.car });

    expect(await listLiveTracks()).toEqual([
      { track_name: "Monza", track_config: "Grand Prix", car_names: ["BMW M4 GT3"], rig_count: 1 },
    ]);
  });
});
