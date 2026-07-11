"use client";

import { useRouter } from "next/navigation";
import { AuthForms } from "./auth-forms";

/** /me for signed-out visitors: sign in (or create a profile) to see laps.
 * Guest creation lives on the rig QR page, where it makes sense. */
export function SignInGate() {
  const router = useRouter();
  return (
    <main className="flex-1 flex flex-col items-center justify-center gap-6 p-6">
      <div className="text-center">
        <h1 className="text-3xl font-black">Your laps live here</h1>
        <p className="text-muted mt-2 max-w-xs">
          Sign in to see tonight&apos;s times, personal bests, and history.
        </p>
      </div>
      <AuthForms showGuest={false} defaultMode="login" onSignedIn={() => router.refresh()} />
    </main>
  );
}
