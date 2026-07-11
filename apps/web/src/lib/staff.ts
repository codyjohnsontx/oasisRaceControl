import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { query, queryOne } from "./db";

const COOKIE_NAME = "oasis_staff";
const MAX_AGE_SECONDS = 12 * 60 * 60; // staff sessions last a shift, not months

export type StaffUser = { userId: string; displayName: string };

function secret(): Uint8Array {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("Missing environment variable SESSION_SECRET");
  return new TextEncoder().encode(value);
}

export async function setStaffSession(user: StaffUser): Promise<void> {
  const jwt = await new SignJWT({ name: user.displayName })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.userId)
    .setAudience("staff")
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secret());

  const store = await cookies();
  store.set(COOKIE_NAME, jwt, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: MAX_AGE_SECONDS,
    path: "/",
  });
}

export async function clearStaffSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

/** The signed-in staff member, or null. The staff_users row is re-checked on
 * every call so a deleted staff account loses access immediately. */
export async function getStaffUser(): Promise<StaffUser | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;

  let staffId: string;
  try {
    const { payload } = await jwtVerify(token, secret(), {
      algorithms: ["HS256"],
      audience: "staff",
    });
    if (!payload.sub) return null;
    staffId = payload.sub;
  } catch {
    return null;
  }

  const row = await queryOne<{ id: string; display_name: string }>(
    "select id, display_name from staff_users where id = $1",
    [staffId],
  );
  if (!row) return null;
  return { userId: row.id, displayName: row.display_name };
}

export async function writeAudit(entry: {
  staffUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  reason?: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await query(
      `insert into audit_log (staff_user_id, action, target_type, target_id, reason, detail)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        entry.staffUserId,
        entry.action,
        entry.targetType,
        entry.targetId,
        entry.reason ?? null,
        entry.detail ?? null,
      ],
    );
  } catch (error) {
    // The mutation already committed; losing the audit row must at least be
    // loud. Making mutation+audit transactional is a post-MVP migration.
    console.error("[audit] insert failed", { ...entry, error: (error as Error).message });
  }
}
