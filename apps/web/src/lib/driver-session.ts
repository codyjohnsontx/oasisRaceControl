import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const COOKIE_NAME = "oasis_driver";
const MAX_AGE_SECONDS = 180 * 24 * 60 * 60; // stay signed in ~6 months

export type DriverSession = {
  driverId: string;
  displayName: string;
  isGuest: boolean;
};

function secret(): Uint8Array {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("Missing environment variable SESSION_SECRET");
  return new TextEncoder().encode(value);
}

export async function setDriverSession(session: DriverSession): Promise<void> {
  const jwt = await new SignJWT({
    name: session.displayName,
    guest: session.isGuest,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.driverId)
    .setAudience("driver")
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

export async function getDriverSession(): Promise<DriverSession | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    // Audience pins this to the driver plane — staff JWTs share the secret
    // but carry aud "staff" and must never verify as a driver session.
    const { payload } = await jwtVerify(token, secret(), {
      algorithms: ["HS256"],
      audience: "driver",
    });
    if (!payload.sub) return null;
    return {
      driverId: payload.sub,
      displayName: String(payload.name ?? ""),
      isGuest: Boolean(payload.guest),
    };
  } catch {
    return null;
  }
}

export async function clearDriverSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}
