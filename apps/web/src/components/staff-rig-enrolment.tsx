"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Where an operator gets a rig's credentials.
 *
 * Twenty-plus machines are enrolled in one evening, each with one command
 * carrying its own token, and the token is only ever shown here — once, when it
 * is minted. So this panel is built around that single moment: the command is
 * shown ready to paste, copying it is one tap, and dismissing it is deliberate.
 */

export type EnrolmentRig = {
  rig_id: string;
  rig_number: number;
  display_name: string;
};

type Minted = {
  kind: "created" | "rotated";
  rigNumber: number;
  displayName: string;
  agentToken: string;
  qrToken?: string;
};

function rigLabel(rigNumber: number): string {
  return `Rig ${String(rigNumber).padStart(2, "0")}`;
}

export function StaffRigEnrolment({ rigs }: { rigs: EnrolmentRig[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<Minted | null>(null);
  const [copied, setCopied] = useState(false);

  // The next number nobody is standing at, so adding the room in order is
  // pressing the same button twenty-two times.
  const nextNumber = useMemo(() => {
    const taken = new Set(rigs.map((rig) => rig.rig_number));
    let candidate = 1;
    while (taken.has(candidate)) candidate += 1;
    return candidate;
  }, [rigs]);

  const [rigNumber, setRigNumber] = useState<string>("");
  const [displayName, setDisplayName] = useState("");
  const [rotateId, setRotateId] = useState("");

  const number = Number(rigNumber || nextNumber);

  // Read on the client only: this component renders on the server first, where
  // there is no request origin to put in a command an operator will paste.
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  const command = minted
    ? [
        "powershell -ExecutionPolicy Bypass -File .\\Install-RigAgent.ps1 `",
        `  -RigNumber ${minted.rigNumber} \``,
        `  -RigToken '${minted.agentToken}' \``,
        `  -BackendBaseUrl '${origin}'`,
      ].join("\n")
    : "";

  async function send(url: string, body: object, kind: Minted["kind"]) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        setError(
          payload?.error === "rig_number_taken"
            ? `${rigLabel(payload.rigNumber)} already exists. Use “New token” to re-issue its token.`
            : payload?.error === "not_found"
              ? "That rig is no longer there — reload the page."
              : "That didn't go through. Check the connection and try again.",
        );
        return;
      }

      setCopied(false);
      setMinted({
        kind,
        rigNumber: payload.rig.rigNumber,
        displayName: payload.rig.displayName,
        agentToken: payload.agentToken,
        qrToken: payload.qrToken,
      });
      setRigNumber("");
      setDisplayName("");
      router.refresh();
    } catch {
      setError("Network problem — nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  function addRig(event: React.FormEvent) {
    event.preventDefault();
    void send(
      "/api/staff/rigs",
      {
        rigNumber: number,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      },
      "created",
    );
  }

  function rotate() {
    const rig = rigs.find((candidate) => candidate.rig_id === rotateId);
    if (!rig) return;
    const reason = window.prompt(
      `Issue ${rigLabel(rig.rig_number)} a new token?\n\n` +
        "The old one stops working now. That machine will show TOKEN REFUSED " +
        "and score nothing until it is re-enrolled with the new one. Laps it " +
        "has already recorded are held, not lost.\n\nReason:",
    );
    if (!reason?.trim()) return;
    void send("/api/staff/rigs/rotate-token", { rigId: rig.rig_id, reason }, "rotated");
  }

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setError("Copying isn't available in this browser — select the command and copy it.");
    }
  }

  return (
    <section>
      <div className="flex items-baseline justify-between gap-4 mb-3">
        <h2 className="text-muted font-bold uppercase tracking-wider text-sm">Enrolment</h2>
        <button
          type="button"
          onClick={() => setOpen((wasOpen) => !wasOpen)}
          className="text-muted text-xs underline underline-offset-4"
        >
          {open ? "Hide" : "Add a rig or re-issue a token"}
        </button>
      </div>

      {minted && (
        <div className="border border-sunset rounded-xl p-4 mb-4 flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-4">
            <h3 className="font-black">
              {rigLabel(minted.rigNumber)}
              <span className="text-muted font-normal">
                {" "}
                · {minted.kind === "created" ? "added" : "new token"}
              </span>
            </h3>
            <p className="text-sunset text-[11px] font-bold uppercase tracking-wider">
              Shown once — not recoverable
            </p>
          </div>

          <p className="text-muted text-xs leading-relaxed">
            Run this at {rigLabel(minted.rigNumber)}, signed in as the account that
            runs iRacing, in an administrator PowerShell. Nobody can read this token
            back afterwards — if it is lost, issue a new one.
          </p>

          <pre className="bg-surface border border-edge rounded-lg p-3 text-[11px] leading-relaxed overflow-x-auto whitespace-pre">
            {command}
          </pre>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void copyCommand()}
              className="text-xs font-bold uppercase tracking-wider border border-edge rounded-md px-3 py-1"
            >
              {copied ? "Copied" : "Copy command"}
            </button>
            <button
              type="button"
              onClick={() => setMinted(null)}
              className="text-xs font-bold uppercase tracking-wider text-muted underline underline-offset-4"
            >
              Done
            </button>
          </div>

          {minted.qrToken && (
            <p className="text-muted text-[11px] break-all border-t border-edge pt-3">
              Print this rig&apos;s QR code from{" "}
              <code className="text-ink">{origin}/r/{minted.qrToken}</code> — it is
              what a customer scans to check in here.
            </p>
          )}
        </div>
      )}

      {open && (
        <div className="bg-surface border border-edge rounded-xl p-4 flex flex-col gap-4">
          <form onSubmit={addRig} className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-muted text-[11px] uppercase tracking-wider">Rig number</span>
              <input
                type="number"
                min={1}
                max={999}
                value={rigNumber}
                placeholder={String(nextNumber)}
                onChange={(event) => setRigNumber(event.target.value)}
                className="bg-bg border border-edge rounded-md px-3 py-2 w-28"
              />
            </label>
            <label className="flex flex-col gap-1 flex-1 min-w-40">
              <span className="text-muted text-[11px] uppercase tracking-wider">
                Name (optional)
              </span>
              <input
                type="text"
                maxLength={60}
                value={displayName}
                placeholder={rigLabel(number)}
                onChange={(event) => setDisplayName(event.target.value)}
                className="bg-bg border border-edge rounded-md px-3 py-2 w-full"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="text-xs font-bold uppercase tracking-wider border border-edge rounded-md px-4 py-2 disabled:opacity-40"
            >
              Add rig
            </button>
          </form>

          <div className="flex flex-wrap items-end gap-3 border-t border-edge pt-4">
            <label className="flex flex-col gap-1 flex-1 min-w-40">
              <span className="text-muted text-[11px] uppercase tracking-wider">
                Re-issue a token
              </span>
              <select
                value={rotateId}
                onChange={(event) => setRotateId(event.target.value)}
                className="bg-bg border border-edge rounded-md px-3 py-2 w-full"
              >
                <option value="">Pick a rig…</option>
                {rigs.map((rig) => (
                  <option key={rig.rig_id} value={rig.rig_id}>
                    {rigLabel(rig.rig_number)} · {rig.display_name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={busy || !rotateId}
              onClick={rotate}
              className="text-xs font-bold uppercase tracking-wider text-invalid border border-invalid rounded-md px-4 py-2 disabled:opacity-40"
            >
              New token
            </button>
          </div>

          <p className="text-muted text-[11px] leading-relaxed">
            Every rig gets its own token — two machines on one token hold each
            other&apos;s laps rather than scoring them.
          </p>
        </div>
      )}

      {error && <p className="text-invalid text-sm mt-3">{error}</p>}
    </section>
  );
}
