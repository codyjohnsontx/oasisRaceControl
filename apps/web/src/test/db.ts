import { describe } from "vitest";
import { Pool } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { safeTestDatabaseUrl } from "./db-guard";

/**
 * Test-only database access and fixture factories for the integration suite.
 * Routes under test use the app's own pool (@/lib/db) via DATABASE_URL, which
 * vitest.integration.config.ts sets from the validated TEST_DATABASE_URL. This
 * separate pool is for arranging fixtures and asserting final state.
 */

const url = safeTestDatabaseUrl();

/** `describe` when a safe test database is configured, `describe.skip` otherwise. */
export const describeDb = url ? describe : describe.skip;

let pool: Pool | undefined;

export function testDb(): Pool {
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  if (!pool) pool = new Pool({ connectionString: url, max: 4 });
  return pool;
}

export async function closeTestDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/**
 * Empties every application table. `truncate ... cascade` in one statement so
 * foreign keys never block the reset, and restarts identity so audit_log ids
 * stay predictable across cases.
 */
export async function resetDb(): Promise<void> {
  await testDb().query(`
    truncate laps, rig_assignments, sim_sessions, rig_qr_tokens,
             pin_attempts, audit_log, featured_combos,
             rigs, drivers, staff_users
    restart identity cascade
  `);
}

/** sha256 of a bearer token, matching lib/agent-auth's storage format. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type SeededRig = {
  id: string;
  rigNumber: number;
  agentToken: string;
  qrToken: string;
};

/** Inserts a rig with an agent bearer token and an active QR token. */
export async function seedRig(rigNumber: number): Promise<SeededRig> {
  const agentToken = `test-agent-token-${rigNumber}-${randomUUID()}`;
  const qrToken = `test-qr-${rigNumber}-${randomUUID()}`;

  const { rows } = await testDb().query<{ id: string }>(
    `insert into rigs (rig_number, display_name, agent_token_hash)
     values ($1, $2, $3) returning id`,
    [rigNumber, `Rig ${String(rigNumber).padStart(2, "0")}`, tokenHash(agentToken)],
  );
  const id = rows[0]!.id;

  await testDb().query(
    "insert into rig_qr_tokens (token, rig_id, active) values ($1, $2, true)",
    [qrToken, id],
  );

  return { id, rigNumber, agentToken, qrToken };
}

/** Inserts a driver. Guests carry no PIN, matching the guest_has_no_pin check. */
export async function seedDriver(
  displayName: string,
  options: { isGuest?: boolean } = {},
): Promise<{ id: string; displayName: string }> {
  const isGuest = options.isGuest ?? true;
  const { rows } = await testDb().query<{ id: string }>(
    `insert into drivers (display_name, is_guest, pin_hash)
     values ($1, $2, $3) returning id`,
    [displayName, isGuest, isGuest ? null : "$2b$10$notarealhashusedintestsonly"],
  );
  return { id: rows[0]!.id, displayName };
}

/** Opens an assignment directly, bypassing the check-in route. */
export async function openAssignment(
  rigId: string,
  driverId: string,
): Promise<string> {
  const { rows } = await testDb().query<{ id: string }>(
    "insert into rig_assignments (rig_id, driver_id) values ($1, $2) returning id",
    [rigId, driverId],
  );
  return rows[0]!.id;
}

/** Sets tonight's featured combo, which drives server-side lap validity. */
export async function setFeaturedCombo(combo: {
  trackName: string;
  trackConfig?: string | null;
  carName: string;
  incidentLimit?: number;
}): Promise<void> {
  await testDb().query(
    `insert into featured_combos (combo_date, track_name, track_config, car_name, incident_limit)
     values (venue_today(), $1, $2, $3, $4)
     on conflict (combo_date) do update set
       track_name = excluded.track_name,
       track_config = excluded.track_config,
       car_name = excluded.car_name,
       incident_limit = excluded.incident_limit`,
    [combo.trackName, combo.trackConfig ?? null, combo.carName, combo.incidentLimit ?? 0],
  );
}

export async function lapRows(): Promise<
  Array<{
    event_id: string;
    // Null on a lap nobody can be credited with - see db/migrations/0003.
    driver_id: string | null;
    rig_assignment_id: string | null;
    is_valid: boolean;
    invalid_reason: string | null;
    lap_time_ms: number;
  }>
> {
  const { rows } = await testDb().query(
    `select event_id, driver_id, rig_assignment_id, is_valid, invalid_reason, lap_time_ms
     from laps order by created_at, event_id`,
  );
  return rows;
}

export async function assignmentRows(): Promise<
  Array<{
    id: string;
    rig_id: string;
    driver_id: string;
    ended_at: Date | null;
    end_reason: string | null;
  }>
> {
  const { rows } = await testDb().query(
    `select id, rig_id, driver_id, ended_at, end_reason
     from rig_assignments order by started_at, id`,
  );
  return rows;
}
