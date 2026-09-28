"use client";

import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import type { Board } from "@/lib/leaderboards";
import type { TvMode, TvSlide } from "@/lib/tv-rotation";
import type { TvHostLogo } from "@/lib/tv-host-logo";
import { TV_BOARD_TYPES, buildRotation } from "./board-types";
import { SLOT_COUNT } from "./arcade-board";
import { PhoneStandingsQr } from "./phone-standings-qr";

/**
 * The `/tv` rotation engine.
 *
 * Runs the wall display: cycles slides on a timer, refreshes whatever is on
 * screen, and re-reads which boards exist. It knows nothing about leaderboards -
 * only the `TvBoardDefinition` contract (see `lib/tv-rotation.ts`), so a new
 * board type drops into `board-types.tsx` without touching this file.
 *
 * Unattended-operation rules, which are the whole point of this component:
 *
 *  - A slide whose load fails or comes back empty is skipped, not shown. If a
 *    whole pass finds nothing playable, the last good board stays up (dimmed and
 *    flagged) rather than blanking the wall.
 *  - Every load is bounded by `LOAD_TIMEOUT_MS`. A request that hangs can't wedge
 *    the rotation, which is how a display ends up frozen until someone reloads it.
 *  - Failure never stops the loop: the same timers that rotate also retry, so the
 *    board comes back on its own the moment data returns.
 *  - Nothing here reacts to input, except the event view's list, which a hand
 *    on a touch screen can take over for a while (`auto-scroll.tsx`). The
 *    board disallows every other touch gesture, so a tap on a projected screen
 *    cannot zoom or flash-select it; the app-wide Screens button is outside it.
 */

type Props = {
  /** Server-rendered rotation seed, so the first paint already has a board. */
  initialBoards: Board[];
  /**
   * Which rotation list to play (`lib/tv-rotation.ts`). The event view is a
   * one-slide list, so the engine below runs it unchanged - the only things
   * that know the mode here are the list builder, the re-read of which boards
   * exist (there is nothing to re-read), and the footer's board counter.
   */
  mode: TvMode;
  /**
   * The event's host, drawn in the footer where the rotation names its board
   * (`lib/tv-host-logo.ts`). Only the event view has one; null draws nothing.
   */
  hostLogo: TvHostLogo | null;
};

/** How long each board holds the screen. Long enough to read ten rows, short
 *  enough that a passer-by sees the rotation move. */
const SLIDE_MS = 15_000;
/** Live refresh of the board currently on screen. */
const REFRESH_MS = 5_000;
/** Re-read which boards exist; new tracks appear here. */
const ROTATION_REFRESH_MS = 120_000;
/** Retry delay after a pass found nothing playable. */
const RETRY_MS = 5_000;
/** A single load may not outlive this - a hung fetch must not freeze the wall. */
const LOAD_TIMEOUT_MS = 8_000;
/** Drives every deadline above. */
const TICK_MS = 500;

/** Distinguishes "load failed" from a board type whose data legitimately is null. */
const LOAD_FAILED = Symbol("load-failed");

type View = {
  slide: TvSlide;
  index: number;
  data: unknown;
  /**
   * Bumped on every advance, including one that lands back on the same slide
   * because it is the only playable one. Keys the slide-progress animation, so
   * the bar restarts each pass instead of sitting pinned full on a wall that is
   * supposed to look like it is moving.
   */
  advanceId: number;
};

export function TvScreen({ initialBoards, mode, hostLogo }: Props) {
  const [slides, setSlides] = useState<TvSlide[]>(() => buildRotation(initialBoards, mode));
  const [view, setView] = useState<View | null>(null);
  const [stale, setStale] = useState(false);
  const [offline, setOffline] = useState(false);

  // The engine lives in one effect so its scheduling state is plain local
  // variables rather than a pile of refs. These two refs are the only bridges:
  // one lets a board ask for a hold, the other lets the page force a tick.
  const holdRef = useRef<(ms: number) => void>(() => {});
  const wakeRef = useRef<() => void>(() => {});

  const hold = useCallback((ms: number) => holdRef.current(ms), []);

  useEffect(() => {
    const teardown = new AbortController();
    let cancelled = false;

    let rotation = buildRotation(initialBoards, mode);
    let current: View | null = null;
    let index = -1;
    let holdUntil = 0;
    let nextAdvanceAt = 0; // first tick advances immediately
    let nextRefreshAt = Number.POSITIVE_INFINITY;
    // An empty seed means either the server-side list failed or the venue has no
    // boards yet. Re-read it on the first tick instead of standing by for a full
    // refresh interval on a wall that has months of records behind it. The
    // event view's list does not depend on which boards exist, so it is never
    // re-read.
    let nextRotationAt =
      mode === "event"
        ? Number.POSITIVE_INFINITY
        : initialBoards.length > 0
          ? Date.now() + ROTATION_REFRESH_MS
          : 0;
    let advanceId = 0;
    let ticking = false;

    holdRef.current = (ms) => {
      holdUntil = Math.max(holdUntil, Date.now() + ms);
    };

    const show = (next: View | null) => {
      current = next;
      setView(next);
    };

    /** Load one slide, bounded by a timeout. Never throws. */
    const load = async (
      definition: (typeof TV_BOARD_TYPES)[string],
      slide: TvSlide,
    ): Promise<unknown | typeof LOAD_FAILED> => {
      try {
        const signal = AbortSignal.any([
          teardown.signal,
          AbortSignal.timeout(LOAD_TIMEOUT_MS),
        ]);
        return await definition.load(slide.spec, signal);
      } catch (error) {
        if (!cancelled) {
          console.error(`[tv] board ${slide.key} failed`, (error as Error).message);
        }
        return LOAD_FAILED;
      }
    };

    /** Walk forward to the next slide that loads and has something to show. */
    const advance = async () => {
      nextAdvanceAt = Date.now() + RETRY_MS; // replaced on success

      let sawFailure = false;
      for (let step = 1; step <= rotation.length; step++) {
        if (cancelled) return;
        const candidate = (index + step) % rotation.length;
        const slide = rotation[candidate];
        const definition = TV_BOARD_TYPES[slide.kind];
        if (!definition) continue;

        const data = await load(definition, slide);
        if (data === LOAD_FAILED) {
          sawFailure = true;
          continue;
        }
        if (!definition.hasContent(data)) continue; // empty board: never shown

        index = candidate;
        advanceId += 1;
        show({ slide, index: candidate, data, advanceId });
        setStale(false);
        setOffline(false);
        nextAdvanceAt = Date.now() + SLIDE_MS;
        nextRefreshAt = Date.now() + REFRESH_MS;
        return;
      }

      // Nothing playable this pass. Hold the last good board if there is one -
      // a frozen leaderboard beats a blank wall - otherwise show standby.
      if (current) setStale(true);
      else show(null);
      setOffline(sawFailure);
    };

    /** Keep the board on screen live without moving off it. */
    const refreshActive = async () => {
      nextRefreshAt = Date.now() + REFRESH_MS;
      if (!current) return;
      const definition = TV_BOARD_TYPES[current.slide.kind];
      if (!definition) return;

      const data = await load(definition, current.slide);
      if (cancelled) return;
      if (data === LOAD_FAILED) {
        setStale(true);
        return;
      }
      if (!definition.hasContent(data)) {
        nextAdvanceAt = 0; // board emptied out under us: move along now
        return;
      }
      show({ ...current, data });
      setStale(false);
      setOffline(false);
    };

    /** Re-read the rotation list, staying on the current board if it survived. */
    const refreshRotation = async () => {
      nextRotationAt = Date.now() + ROTATION_REFRESH_MS;
      try {
        const res = await fetch("/api/leaderboards/boards", {
          cache: "no-store",
          signal: AbortSignal.any([teardown.signal, AbortSignal.timeout(LOAD_TIMEOUT_MS)]),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const payload = (await res.json()) as { boards?: unknown };
        if (!Array.isArray(payload.boards)) throw new Error("malformed boards response");
        if (cancelled) return;

        rotation = buildRotation(payload.boards as Board[], mode);
        setSlides(rotation);
        const activeKey = current?.slide.key;
        index = activeKey ? rotation.findIndex((s) => s.key === activeKey) : -1;
        if (current) {
          // A -1 index means the board on screen just dropped out of the
          // rotation - its last valid lap was invalidated, say. Leave it up
          // rather than blanking the wall, but stop claiming a position it no
          // longer holds and move along on the next tick.
          show({ ...current, index });
          if (index < 0) nextAdvanceAt = 0;
        }
      } catch (error) {
        // Keep the rotation we already have, and come back sooner than the
        // normal cadence: what we're holding may be a seed that never loaded,
        // and a wall that doesn't know its boards stands by looking empty.
        nextRotationAt = Date.now() + RETRY_MS;
        if (!cancelled) {
          console.error("[tv] rotation refresh failed", (error as Error).message);
        }
      }
    };

    const tick = async () => {
      if (cancelled || ticking) return;
      ticking = true;
      try {
        const now = Date.now();
        if (now >= nextRotationAt) await refreshRotation();
        if (now >= nextAdvanceAt && now >= holdUntil) await advance();
        else if (now >= nextRefreshAt) await refreshActive();
      } finally {
        ticking = false;
      }
    };

    wakeRef.current = () => {
      nextAdvanceAt = 0;
      void tick();
    };

    // A kiosk that gets backgrounded (screensaver, display sleep) has its timers
    // throttled; catch up the moment it's visible again instead of showing
    // whatever was frozen on screen. Same for the network coming back.
    const onVisible = () => {
      if (document.visibilityState === "visible") wakeRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);

    const timer = setInterval(() => void tick(), TICK_MS);
    void tick();

    return () => {
      cancelled = true;
      clearInterval(timer);
      teardown.abort();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      holdRef.current = () => {};
      wakeRef.current = () => {};
    };
  }, [initialBoards, mode]);

  const definition = view ? TV_BOARD_TYPES[view.slide.kind] : undefined;
  // -1 until the next advance whenever the board on screen has dropped out of a
  // freshly re-read rotation: it is still worth showing, it just has no position.
  const position = view ? view.index : -1;

  return (
    <main className="tv-scale relative flex h-dvh touch-none flex-col overflow-hidden p-[2.5em] select-none">
      {/* Fills over one slide's hold, so the room can see the rotation coming.
          Keyed on the advance counter rather than the slide, so a rotation with
          one playable board still restarts the fill every pass. The event view
          has nothing coming, so it shows no timer. */}
      <div className="absolute inset-x-0 top-0 h-[0.375em] overflow-hidden">
        {view && mode === "rotation" && (
          <div
            key={view.advanceId}
            className="tv-slide-progress gradient-rule h-full origin-left"
            style={{ "--tv-slide-duration": `${SLIDE_MS}ms` } as CSSProperties}
          />
        )}
      </div>

      {definition && view ? (
        <definition.Board spec={view.slide.spec} data={view.data} stale={stale} hold={hold} />
      ) : (
        <Standby offline={offline} />
      )}

      <footer className="mt-[1.5em] flex shrink-0 items-center justify-between gap-[2em]">
        <div className="flex min-w-0 items-center gap-[1.5em]">
          {slides.length > 1 && slides.length <= 16 && (
            <div className="flex items-center gap-[0.5em]" aria-hidden="true">
              {slides.map((slide, i) => (
                <span
                  key={slide.key}
                  className={`h-[0.5em] rounded-full transition-all duration-500 ${
                    i === position ? "bg-accent w-[2em]" : "bg-edge w-[0.5em]"
                  }`}
                />
              ))}
            </div>
          )}
          {/* The event view's board is the only board, so this corner names
              the event's host instead - or, with no host in the link, nothing.
              Mark and wordmark are one lockup: the wordmark is the host's own
              lettering, so it is an image at a height chosen against the mark,
              not a caption in the board's type. */}
          {mode === "event" ? (
            hostLogo && (
              <div className="flex shrink-0 items-center gap-[0.75em]">
                <Image
                  src={hostLogo.mark.src}
                  alt={hostLogo.alt}
                  width={hostLogo.mark.width}
                  height={hostLogo.mark.height}
                  priority
                  unoptimized
                  className="h-[4.25em] w-auto invert"
                />
                {hostLogo.wordmark && (
                  <Image
                    src={hostLogo.wordmark.src}
                    alt=""
                    width={hostLogo.wordmark.width}
                    height={hostLogo.wordmark.height}
                    priority
                    unoptimized
                    className="h-[3.5em] w-auto invert"
                  />
                )}
              </div>
            )
          ) : (
            <p className="text-ink/80 min-w-0 truncate text-[1.25em] font-bold uppercase tracking-[0.2em]">
              {position >= 0
                ? `Board ${position + 1} of ${slides.length}`
                : view
                  ? `Top ${SLOT_COUNT} per board`
                  : `Standing by · Top ${SLOT_COUNT} per board`}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-[1.25em]">
          {/* Pulses the same way the standby card's helmet does: the owner
              wanted the wall to look alive in the corner too. */}
          <Image
            src="/oasishelmet.png"
            alt=""
            width={49}
            height={60}
            priority
            className="h-[2.75em] w-auto animate-pulse"
          />
          {/* `stale` covers a board held through a failure; `offline` covers a
              failure with no board to hold. Either way the feed is down. */}
          <Wordmark stale={stale || offline} />
          {/* In the footer's flow rather than pinned over the board, so the
              rows above give it room by construction and it never covers one.
              It reads the origin after hydration, so the server paint has no
              code - the footer grows to fit it a moment later. */}
          <PhoneStandingsQr />
        </div>
      </footer>
    </main>
  );
}

/**
 * The wordmark doubles as the feed status, so the footer carries one thing
 * there rather than a chip beside it: a green dot and "Oasis Live Timing"
 * while the numbers are live, and the same slot turning to a pulsing orange
 * dot and "Reconnecting" while they are held. Saying the word matters - an
 * unattended wall must tell the room out loud when its numbers are not live.
 */
function Wordmark({ stale }: { stale: boolean }) {
  return (
    <p
      className={`font-display flex items-center gap-[0.75em] text-[1.125em] font-bold uppercase tracking-[0.3em] ${
        stale ? "text-sunset" : "text-accent text-glow-subtle"
      }`}
    >
      <span
        className={`h-[0.625em] w-[0.625em] shrink-0 rounded-full ${stale ? "bg-sunset animate-pulse" : "bg-valid"}`}
      />
      {stale ? "Reconnecting" : "Oasis Live Timing"}
    </p>
  );
}

/**
 * Shown only when there is genuinely nothing to put up: a brand-new venue with
 * no laps, or a cold start while the feed is down. Deliberately a title card,
 * not an error - it is on a wall in a shop.
 */
function Standby({ offline }: { offline: boolean }) {
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-[2em] text-center">
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
      <p className="text-muted text-[2.25em]">
        {offline
          ? "Reconnecting to timing…"
          : "High scores go up as soon as the first lap lands."}
      </p>
    </section>
  );
}
