"use client";

import { useEffect } from "react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { tvMode } from "@/lib/tv-rotation";

/**
 * Last line of defence for the wall display. If anything on `/tv` throws hard
 * enough to unmount the rotation, nobody is standing there to press reload - so
 * this shows a title card and retries on its own, forever. It carries the
 * screen's `data-tv-mode`, so the event view keeps its Screens menu hidden
 * (`globals.css`) while it waits.
 */
const RETRY_MS = 10_000;

export default function TvError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const mode = tvMode(useSearchParams().get("event") ?? undefined);
  useEffect(() => {
    console.error("[tv] screen crashed", error.message, error.digest);
    const retry = setInterval(reset, RETRY_MS);
    return () => clearInterval(retry);
  }, [error, reset]);

  return (
    <main
      data-tv-mode={mode}
      className="tv-scale flex h-dvh flex-col items-center justify-center gap-[2em] p-[2.5em] text-center select-none"
    >
      <Image
        src="/oasishelmet.png"
        alt=""
        width={49}
        height={60}
        priority
        className="h-[8em] w-auto animate-pulse"
      />
      <h1 className="font-display gradient-text text-[6em]/[1.1] font-black uppercase tracking-tight">
        Oasis Sim Racing
      </h1>
      <p className="text-muted text-[2.25em]">Reconnecting to timing…</p>
    </main>
  );
}
