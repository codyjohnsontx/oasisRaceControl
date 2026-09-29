/**
 * A PIN chosen for a new profile is typed twice, and only the same four
 * digits twice are sent. A PIN mistyped once at sign-up is one its owner can
 * never sign back in with - that is how a returning driver was locked out of
 * their own name at the 2026-09-28 event - and only staff can fix it
 * afterwards, with Reset PIN on /staff. The rig console asks the same way
 * (`SignInState` in apps/rig-agent/OasisRigAgent/DriverPrompt.cs).
 */

/** Why a new profile's PIN cannot be sent yet, or null when it can. */
export function newPinRefusal(pin: string, again: string): string | null {
  if (!/^\d{4}$/.test(pin)) return "The PIN is exactly 4 digits";
  if (again !== pin) return "The two PINs don't match - type the same PIN in both boxes";
  return null;
}
