"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";

export default function StaffLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true);
    setError(null);
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      setError("Sign-in failed");
      return;
    }
    router.push("/staff");
    router.refresh();
  }

  return (
    <main className="flex-1 flex flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-3xl font-black">Staff sign-in</h1>
      <form
        className="flex flex-col gap-3 w-full max-w-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void signIn();
        }}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          autoComplete="email"
          required
          className="bg-surface border border-edge rounded-lg px-4 py-3 outline-none focus:border-accent"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete="current-password"
          required
          className="bg-surface border border-edge rounded-lg px-4 py-3 outline-none focus:border-accent"
        />
        {error && <p className="text-invalid text-sm">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="bg-accent rounded-lg py-3 font-bold uppercase tracking-wider disabled:opacity-40"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
