import bcrypt from "bcryptjs";
import { z } from "zod";
import { query, queryOne } from "./db";

export const displayNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(24)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u, "Letters, numbers, and . _ ' - only");

export const pinSchema = z.string().regex(/^\d{4}$/, "PIN must be 4 digits");

const MAX_FAILS = 5;

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, 10);
}

export async function verifyPin(pin: string, pinHash: string): Promise<boolean> {
  return bcrypt.compare(pin, pinHash);
}

/** Returns the ISO time the account is locked until, or null if usable. */
export async function checkLockout(driverId: string): Promise<string | null> {
  const row = await queryOne<{ locked_until: Date | null }>(
    "select locked_until from pin_attempts where driver_id = $1",
    [driverId],
  );
  if (row?.locked_until && new Date(row.locked_until) > new Date()) {
    return new Date(row.locked_until).toISOString();
  }
  return null;
}

/** Records a failed PIN attempt; locks the account for 15 minutes after
 * MAX_FAILS. Single atomic statement — concurrent failures can't undercount. */
export async function recordPinFailure(driverId: string): Promise<void> {
  await query(
    `insert into pin_attempts (driver_id, fail_count, locked_until, updated_at)
     values ($1, 1, null, now())
     on conflict (driver_id) do update set
       fail_count = case
         when pin_attempts.fail_count + 1 >= $2 then 0
         else pin_attempts.fail_count + 1
       end,
       locked_until = case
         when pin_attempts.fail_count + 1 >= $2 then now() + interval '15 minutes'
         else pin_attempts.locked_until
       end,
       updated_at = now()`,
    [driverId, MAX_FAILS],
  );
}

export async function clearPinFailures(driverId: string): Promise<void> {
  await query("delete from pin_attempts where driver_id = $1", [driverId]);
}
