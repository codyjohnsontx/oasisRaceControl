"use client";

import { useState } from "react";
import type { DriverAuthMode as Mode } from "@/lib/driver-auth-refusal";
import { submitDriverAuth } from "@/lib/driver-auth-submit";

type Props = {
  /** Called after the driver is signed in (any mode). */
  onSignedIn: (displayName: string) => void;
  /** Guest tab is the default posture at the rig; /me leads with login. */
  defaultMode?: Mode;
  showGuest?: boolean;
};

export function AuthForms({ onSignedIn, defaultMode = "guest", showGuest = true }: Props) {
  const [mode, setMode] = useState<Mode>(showGuest ? defaultMode : "login");
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [pinAgain, setPinAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setMessage(null);
    const result = await submitDriverAuth(mode, { name, pin, pinAgain });
    setBusy(false);
    if (result.ok) onSignedIn(result.displayName);
    else setMessage(result.message);
  }

  const tab = (m: Mode, label: string) => (
    <button
      key={m}
      type="button"
      onClick={() => {
        setMode(m);
        setMessage(null);
      }}
      className={`flex-1 py-2 text-sm font-bold uppercase tracking-wider rounded-md ${
        mode === m ? "bg-accent text-bg" : "text-muted"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="w-full max-w-sm">
      <div className="flex gap-1 bg-surface rounded-lg p-1 mb-4">
        {showGuest && tab("guest", "Guest")}
        {tab("login", "Sign in")}
        {tab("register", "New profile")}
      </div>

      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="driver-name" className="sr-only">
          Display name
        </label>
        <input
          id="driver-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Display name"
          autoComplete="username"
          required
          minLength={2}
          maxLength={24}
          className="bg-surface border border-edge rounded-lg px-4 py-3 text-lg outline-none focus:border-accent"
        />
        {mode !== "guest" && (
          <>
            <label htmlFor="driver-pin" className="sr-only">
              4-digit PIN
            </label>
            <input
              id="driver-pin"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder={mode === "register" ? "Choose a 4-digit PIN" : "4-digit PIN"}
              inputMode="numeric"
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              required
              pattern="\d{4}"
              className="bg-surface border border-edge rounded-lg px-4 py-3 text-lg outline-none focus:border-accent laptime"
            />
          </>
        )}
        {mode === "register" && (
          <>
            <label htmlFor="driver-pin-again" className="sr-only">
              Type the PIN again
            </label>
            <input
              id="driver-pin-again"
              value={pinAgain}
              onChange={(e) => setPinAgain(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder="Type the PIN again"
              inputMode="numeric"
              autoComplete="new-password"
              required
              pattern="\d{4}"
              className="bg-surface border border-edge rounded-lg px-4 py-3 text-lg outline-none focus:border-accent laptime"
            />
          </>
        )}
        {message && <p className="text-invalid text-sm">{message}</p>}
        <button
          type="submit"
          disabled={
            busy ||
            name.trim().length < 2 ||
            (mode !== "guest" && pin.length !== 4) ||
            (mode === "register" && pinAgain.length !== 4)
          }
          className="bg-accent text-bg glow-cyan rounded-lg py-3 font-bold uppercase tracking-wider disabled:opacity-40"
        >
          {busy ? "…" : mode === "guest" ? "Drive as guest" : mode === "login" ? "Sign in" : "Create profile"}
        </button>
        {mode === "guest" && (
          <p className="text-muted text-xs text-center">
            No account needed — you can save your results afterward.
          </p>
        )}
      </form>
    </div>
  );
}
