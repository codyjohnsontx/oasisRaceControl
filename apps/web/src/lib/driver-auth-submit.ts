import { newPinRefusal } from "./new-pin";
import { driverAuthRefusal, type DriverAuthMode } from "./driver-auth-refusal";

/**
 * What the website's driver forms send when submitted, apart from the forms
 * themselves so the PIN confirmation can be tested against a stand-in
 * `fetch`: a new profile (New profile tab, guest Save profile) whose two PINs
 * differ sends nothing at all, and one whose PINs match sends that one PIN,
 * once. The forms only hold the typed values and show what comes back.
 */

type Fetch = typeof fetch;

export type DriverAuthInput = { name: string; pin: string; pinAgain: string };
export type DriverAuthResult = { ok: true; displayName: string } | { ok: false; message: string };

const ENDPOINTS: Record<DriverAuthMode, string> = {
  guest: "/api/auth/guest",
  login: "/api/auth/login",
  register: "/api/auth/register",
};

async function post(fetchImpl: Fetch, endpoint: string, body: unknown): Promise<Response> {
  return fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The Guest, Sign in and New profile tabs. */
export async function submitDriverAuth(
  mode: DriverAuthMode,
  { name, pin, pinAgain }: DriverAuthInput,
  fetchImpl: Fetch = fetch,
): Promise<DriverAuthResult> {
  if (mode === "register") {
    const refusal = newPinRefusal(pin, pinAgain);
    if (refusal) return { ok: false, message: refusal };
  }
  const body = mode === "guest" ? { displayName: name } : { displayName: name, pin };
  try {
    const res = await post(fetchImpl, ENDPOINTS[mode], body);
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, displayName: String(data.displayName ?? name) };
    return { ok: false, message: driverAuthRefusal(mode, data.error, data.suggestion) };
  } catch {
    return { ok: false, message: "Network problem — try again" };
  }
}

export type GuestClaimResult = { ok: true } | { ok: false; message: string };

/** A guest's Save profile: the PIN that makes tonight's name permanent. */
export async function submitGuestClaim(
  { pin, pinAgain }: { pin: string; pinAgain: string },
  fetchImpl: Fetch = fetch,
): Promise<GuestClaimResult> {
  const refusal = newPinRefusal(pin, pinAgain);
  if (refusal) return { ok: false, message: refusal };
  try {
    const res = await post(fetchImpl, "/api/auth/claim", { pin });
    return res.ok ? { ok: true } : { ok: false, message: "Could not save the profile — try again" };
  } catch {
    return { ok: false, message: "Network problem — try again" };
  }
}
