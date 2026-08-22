import { afterAll, beforeEach, expect, it } from "vitest";
import { listUnattributedLaps } from "./unattributed-laps";
import {
  closeTestDb,
  describeDb,
  openAssignment,
  resetDb,
  seedDriver,
  seedRig,
  testDb,
} from "@/test/db";

/**
 * `/staff` is the only surface that opens the unattributed bucket, so what this
 * query does at its edges is what a reader at the counter can and cannot see.
 * The cap is deliberate; the total is what tells them the cap bit. These cases
 * pin the pair together, because a total drawn from a different window or a
 * different predicate than the rows it labels would be worse than no total -
 * it would look precise.
 */

async function seedUnattributedLaps(
  rigId: string,
  count: number,
  options: { minutesAgo?: number } = {},
): Promise<void> {
  const minutesAgo = options.minutesAgo ?? 1;
  await testDb().query(
    `insert into laps (event_id, rig_id, rig_assignment_id, driver_id,
                       track_name, car_name, lap_time_ms, is_valid,
                       invalid_reason, completed_at)
     select 'evt-unclaimed-' || $3 || '-' || i, $1, null, null,
            'Spa-Francorchamps', 'Porsche 911 GT3 R', 90000 + i, false,
            'UNATTRIBUTED', now() - ($3 || ' minutes')::interval - (i || ' seconds')::interval
     from generate_series(1, $2) as i`,
    [rigId, count, minutesAgo],
  );
}

describeDb("listUnattributedLaps", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("reports nothing when no lap is unclaimed", async () => {
    await expect(listUnattributedLaps()).resolves.toEqual({ laps: [], total: 0 });
  });

  it("caps the list but counts every unclaimed lap in the window", async () => {
    const rig = await seedRig(1);
    await seedUnattributedLaps(rig.id, 32);

    const { laps, total } = await listUnattributedLaps();

    expect(laps).toHaveLength(30);
    expect(total).toBe(32);
    // Newest first, so the cap drops the oldest rather than an arbitrary page.
    const times = laps.map((lap) => new Date(lap.completed_at).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("does not report a total when the whole window fits in the list", async () => {
    const rig = await seedRig(1);
    await seedUnattributedLaps(rig.id, 3);

    const { laps, total } = await listUnattributedLaps();

    expect(laps).toHaveLength(3);
    expect(total).toBe(3);
  });

  it("counts over the same window and predicate the list is drawn from", async () => {
    const rig = await seedRig(1);
    const driver = await seedDriver("Cody J");
    const assignmentId = await openAssignment(rig.id, driver.id);
    await seedUnattributedLaps(rig.id, 1);
    // Older than the window, and a lap that has an owner: neither belongs in
    // the list, so neither may show up in the number labelling it.
    await seedUnattributedLaps(rig.id, 40, { minutesAgo: 8 * 24 * 60 });
    await testDb().query(
      `insert into laps (event_id, rig_id, rig_assignment_id, driver_id,
                         track_name, car_name, lap_time_ms, is_valid, completed_at)
       values ('evt-attributed-0001', $1, $2, $3, 'Spa-Francorchamps',
               'Porsche 911 GT3 R', 91000, true, now())`,
      [rig.id, assignmentId, driver.id],
    );

    const { laps, total } = await listUnattributedLaps();

    expect(laps).toHaveLength(1);
    expect(total).toBe(1);
  });
});
