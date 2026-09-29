/**
 * What the website's Guest, Sign in and New profile tabs say when the backend
 * refuses. The rig asks the same way (`SignInState` in
 * apps/rig-agent/OasisRigAgent/DriverPrompt.cs): a taken name on New profile
 * points a returning driver at Sign in rather than at a different name, and a
 * wrong PIN points them at staff, who reset PINs on /staff.
 */

export type DriverAuthMode = "guest" | "login" | "register";

export function driverAuthRefusal(mode: DriverAuthMode, error: unknown, suggestion?: unknown): string {
  if (error === "name_taken") {
    if (mode === "register") {
      return "That name is already registered. If it's yours, use Sign in; otherwise pick a different name.";
    }
    return suggestion ? `That name is taken — try “${String(suggestion)}”` : "That name is taken — pick another";
  }
  if (error === "locked") return "Too many wrong PINs — ask staff to reset it, or try later";
  if (error === "invalid_credentials") {
    return "That name and PIN don't match. Try again, or ask staff to reset your PIN. New here? Use New profile.";
  }
  return "Something went wrong — try again";
}
