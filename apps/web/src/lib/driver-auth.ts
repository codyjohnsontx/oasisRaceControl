import bcrypt from "bcryptjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export const displayNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(24)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u, "Letters, numbers, and . _ ' - only");

export const pinSchema = z.string().regex(/^\d{4}$/, "PIN must be 4 digits");

const MAX_FAILS = 5;
const LOCKOUT_MINUTES = 15;

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, 10);
}

export async function verifyPin(pin: string, pinHash: string): Promise<boolean> {
  return bcrypt.compare(pin, pinHash);
}

/** Returns the ISO time the account is locked until, or null if usable. */
export async function checkLockout(
  db: SupabaseClient,
  driverId: string,
): Promise<string | null> {
  const { data } = await db
    .from("pin_attempts")
    .select("locked_until")
    .eq("driver_id", driverId)
    .maybeSingle();
  if (data?.locked_until && new Date(data.locked_until) > new Date()) {
    return data.locked_until;
  }
  return null;
}

/** Records a failed PIN attempt; locks the account after MAX_FAILS. */
export async function recordPinFailure(
  db: SupabaseClient,
  driverId: string,
): Promise<void> {
  const { data } = await db
    .from("pin_attempts")
    .select("fail_count")
    .eq("driver_id", driverId)
    .maybeSingle();

  const failCount = (data?.fail_count ?? 0) + 1;
  const lock = failCount >= MAX_FAILS;
  await db.from("pin_attempts").upsert({
    driver_id: driverId,
    fail_count: lock ? 0 : failCount,
    locked_until: lock
      ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString()
      : null,
    updated_at: new Date().toISOString(),
  });
}

export async function clearPinFailures(
  db: SupabaseClient,
  driverId: string,
): Promise<void> {
  await db.from("pin_attempts").delete().eq("driver_id", driverId);
}

/** Postgres unique-violation code, for display-name collisions. */
export function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}
