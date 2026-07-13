"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function StaffLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/staff/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        setError(res.status === 429 ? "Too many attempts — wait a minute" : "Sign-in failed");
        return;
      }
      router.push("/staff");
      router.refresh();
    } catch {
      setError("Network problem — try again");
    } finally {
      setBusy(false);
    }
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
        <label htmlFor="staff-email" className="sr-only">
          Email
        </label>
        <input
          id="staff-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          autoComplete="email"
          required
          className="bg-surface border border-edge rounded-lg px-4 py-3 outline-none focus:border-accent"
        />
        <label htmlFor="staff-password" className="sr-only">
          Password
        </label>
        <input
          id="staff-password"
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
          className="bg-accent text-bg rounded-lg py-3 font-bold uppercase tracking-wider disabled:opacity-40"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
