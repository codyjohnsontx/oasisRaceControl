"use client";

import { useCallback, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { AuthForms } from "./auth-forms";

type Needs = {
  move?: { fromRigNumber: number };
  takeover?: { currentDriverName: string };
};

type Props = {
  qrToken: string;
  rigNumber: number;
  signedInAs: { displayName: string; isGuest: boolean } | null;
};

type Stage =
  | { kind: "auth" }
  | { kind: "confirm-rig"; displayName: string }
  | { kind: "resolve"; needs: Needs; approved: { move: boolean; takeover: boolean } }
  | { kind: "done"; displayName: string }
  | { kind: "error"; message: string };

export function CheckInFlow({ qrToken, rigNumber, signedInAs }: Props) {
  const [stage, setStage] = useState<Stage>(
    signedInAs
      ? { kind: "confirm-rig", displayName: signedInAs.displayName }
      : { kind: "auth" },
  );
  const [busy, setBusy] = useState(false);
  const [displayName, setDisplayName] = useState(signedInAs?.displayName ?? "");

  const checkin = useCallback(
    async (approved: { move: boolean; takeover: boolean }) => {
      setBusy(true);
      try {
        const res = await fetch("/api/checkin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            qrToken,
            confirmMove: approved.move,
            confirmTakeover: approved.takeover,
          }),
        });
        const data = await res.json().catch(() => ({}));

        if (res.ok && (data.status === "checked_in" || data.status === "already_checked_in")) {
          setStage({ kind: "done", displayName });
        } else if (res.ok && data.status === "needs_confirmation") {
          setStage({ kind: "resolve", needs: data.needs as Needs, approved });
        } else if (res.status === 401) {
          setStage({ kind: "auth" });
        } else if (data.error === "conflict_retry") {
          setStage({ kind: "error", message: "Someone beat you to it — tap to try again." });
        } else {
          setStage({ kind: "error", message: "Check-in failed — tap to try again." });
        }
      } catch {
        setStage({ kind: "error", message: "Network problem — tap to try again." });
      } finally {
        setBusy(false);
      }
    },
    [qrToken, displayName],
  );

  return (
    <main className="flex-1 flex flex-col items-center justify-center gap-8 p-6">
      <header className="text-center flex flex-col items-center">
        <Image
          src="/oasishelmet.png"
          alt="Oasis Sim Racing"
          width={98}
          height={120}
          priority
          className="h-20 w-auto mb-4"
        />
        <p className="font-display text-muted font-semibold tracking-[0.25em] uppercase text-sm">
          You are checking into
        </p>
        <h1 className="font-display text-7xl font-black tracking-tight mt-1 text-accent text-glow">
          RIG {rigNumber.toString().padStart(2, "0")}
        </h1>
      </header>

      {stage.kind === "auth" && (
        <AuthForms
          onSignedIn={(name) => {
            // Session cookie is set; go straight to check-in.
            setDisplayName(name);
            setStage({ kind: "confirm-rig", displayName: name });
            void checkin({ move: false, takeover: false });
          }}
        />
      )}

      {stage.kind === "confirm-rig" && (
        <div className="flex flex-col items-center gap-4 w-full max-w-sm">
          <p className="text-lg">
            Driving as <span className="font-bold">{displayName}</span>
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void checkin({ move: false, takeover: false })}
            className="w-full bg-accent text-bg glow-cyan rounded-lg py-4 text-xl font-black uppercase tracking-wider disabled:opacity-40"
          >
            {busy ? "Checking in…" : `Check in to Rig ${rigNumber}`}
          </button>
          <button
            type="button"
            onClick={() => {
              void fetch("/api/auth/logout", { method: "POST" });
              setDisplayName("");
              setStage({ kind: "auth" });
            }}
            className="text-muted text-sm underline underline-offset-4"
          >
            Not you? Switch driver
          </button>
        </div>
      )}

      {stage.kind === "resolve" && (
        <div className="flex flex-col gap-4 w-full max-w-sm">
          {stage.needs.move && (
            <div className="bg-surface border border-edge rounded-xl p-4">
              <p>
                You&apos;re currently checked into{" "}
                <span className="font-bold">Rig {stage.needs.move.fromRigNumber}</span>.
              </p>
              <p className="text-muted text-sm mt-1">
                Moving here ends that session. Your laps are safe.
              </p>
            </div>
          )}
          {stage.needs.takeover && (
            <div className="bg-surface border border-edge rounded-xl p-4">
              <p>
                Rig {rigNumber} is currently assigned to{" "}
                <span className="font-bold">{stage.needs.takeover.currentDriverName}</span>.
              </p>
              <p className="text-muted text-sm mt-1">
                Only continue if the previous driver is finished.
              </p>
            </div>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void checkin({
                move: stage.approved.move || Boolean(stage.needs.move),
                takeover: stage.approved.takeover || Boolean(stage.needs.takeover),
              })
            }
            className="bg-accent text-bg glow-cyan rounded-lg py-4 text-lg font-black uppercase tracking-wider disabled:opacity-40"
          >
            {stage.needs.takeover ? "They're done — check me in" : `Move to Rig ${rigNumber}`}
          </button>
          <button
            type="button"
            onClick={() => setStage({ kind: "confirm-rig", displayName })}
            className="text-muted text-sm underline underline-offset-4"
          >
            Cancel
          </button>
        </div>
      )}

      {stage.kind === "done" && (
        <div className="flex flex-col items-center gap-5 text-center">
          <div className="text-valid text-6xl">✓</div>
          <p className="text-2xl font-bold">You&apos;re in — go drive!</p>
          <p className="text-muted max-w-xs">
            Your laps will appear on your phone and the big board automatically.
          </p>
          <Link
            href="/me"
            className="bg-surface border border-edge rounded-lg px-8 py-3 font-bold uppercase tracking-wider"
          >
            Watch my laps
          </Link>
        </div>
      )}

      {stage.kind === "error" && (
        <button
          type="button"
          onClick={() => setStage({ kind: "confirm-rig", displayName })}
          className="bg-surface border border-invalid text-invalid rounded-xl px-6 py-4 max-w-sm"
        >
          {stage.message}
        </button>
      )}
    </main>
  );
}
