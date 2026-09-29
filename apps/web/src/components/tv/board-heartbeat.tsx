"use client";

import { useEffect } from "react";
import { BOARD_HEARTBEAT_INTERVAL_MS } from "@/lib/monitor/event-mode";
import { feedHealth } from "@/lib/tv-feed-health";

type Props = {
  /** Signed by the server when it rendered the page (lib/board-ticket.ts). */
  ticket: string;
};

/** How long one heartbeat may take before it is abandoned; the next one follows. */
const HEARTBEAT_TIMEOUT_MS = 10_000;

/**
 * The /tv page telling the rig monitor it is still on the wall: every
 * BOARD_HEARTBEAT_INTERVAL_MS, with whether its boards are loading their
 * numbers (lib/tv-feed-health.ts) and whether it is the visible tab. As the
 * page closes it says goodbye with navigator.sendBeacon, which the browser
 * delivers even as the page goes; a killed browser or a sleeping laptop sends
 * nothing, and that silence is what the monitor alerts on (rule 8a). An open
 * event board is also what turns event mode on.
 *
 * It sits beside the rotation engine (tv-screen.tsx), not inside it: a
 * heartbeat is not a board, and the engine is not changed to add one. It
 * renders nothing, so it can never move a pixel of the wall.
 */
export function BoardHeartbeat({ ticket: initialTicket }: Props) {
  useEffect(() => {
    let ticket = initialTicket;
    let refused = false;
    let reopening = false;

    const payload = (closing: boolean) => {
      const feed = feedHealth();
      return JSON.stringify({
        ticket,
        visible: document.visibilityState === "visible",
        feedOk: feed.ok,
        feedFailures: feed.failures,
        closing,
        ...(reopening && !closing ? { reopened: true } : {}),
      });
    };

    const beat = async () => {
      if (refused) return;
      try {
        const res = await fetch("/api/tv/heartbeat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload(false),
          cache: "no-store",
          signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
        });
        if (res.status === 401) {
          // A ticket the server no longer honours will not start working;
          // stop rather than knock every 30 s. The monitor reads the silence
          // as the board going dark, which it has as far as anyone can tell.
          refused = true;
          console.error("[tv] heartbeat refused; reload the page to report again");
          return;
        }
        if (!res.ok) throw new Error(`status ${res.status}`);
        const answer = (await res.json()) as { ticket?: unknown };
        if (typeof answer.ticket === "string") ticket = answer.ticket;
        reopening = false;
      } catch (error) {
        console.error("[tv] heartbeat failed", (error as Error).message);
      }
    };

    const onPageHide = () => {
      if (!refused) navigator.sendBeacon("/api/tv/heartbeat", payload(true));
    };
    // Back from the back-forward cache: the goodbye went, so report at once,
    // and say so until the server has heard it - only that undoes a goodbye.
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      reopening = true;
      void beat();
    };

    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    void beat();
    const timer = setInterval(() => void beat(), BOARD_HEARTBEAT_INTERVAL_MS);

    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [initialTicket]);

  return null;
}
