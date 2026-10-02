"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveRace } from "@/lib/race-live";
import {
  INITIAL_RACE_BOARD,
  RACE_MOVE_HIGHLIGHT_MS,
  RACE_POLL_MS,
  applyRaceFeed,
  applyRaceFeedFailure,
  placeChanges,
  sessionKey,
  type RaceBoardState,
  type RaceMove,
} from "@/lib/race-board";
import { useVisiblePoll } from "./use-visible-poll";

export type LiveRaceView = {
  /** The race to draw, or null while the screen shows the standings. */
  race: LiveRace | null;
  /** The flag is out and this is the finishing order, held for its minute. */
  finished: boolean;
  /** Rigs whose place changed within the last RACE_MOVE_HIGHLIGHT_MS, by rig number. */
  moves: ReadonlyMap<number, RaceMove>;
  /** The last poll failed; what is on screen is held, not live. */
  stale: boolean;
};

/**
 * Polls the live race feed every RACE_POLL_MS while `active` and the tab is
 * visible, and reduces each answer through `lib/race-board.ts`, which owns
 * every rule about what is shown. The wall's league board and `/league` both
 * use this, so a pass reaches the phone and the wall on the same cadence and
 * the finishing order stays up for the same minute on both.
 *
 * The cadence is the hook's own rather than the TV engine's 5 s refresh: the
 * engine is unchanged (CLAUDE.md), and the board simply asks for the race
 * feed itself while it is on screen.
 */
export function useLiveRace(active: boolean): LiveRaceView {
  const [state, setState] = useState<RaceBoardState>(INITIAL_RACE_BOARD);
  const [stale, setStale] = useState(false);
  const [moves, setMoves] = useState<Map<number, RaceMove>>(() => new Map());
  // The poll compares each answer with the last one it accepted, outside a
  // render, so the last state is kept on a ref the effect below maintains.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const seq = useRef(0);
  const unmarkTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const refresh = useCallback(async () => {
    let feed: LiveRace;
    try {
      const res = await fetch("/api/race/live", { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      feed = (await res.json()) as LiveRace;
      if (!Array.isArray(feed.rows)) throw new Error("malformed race response");
    } catch {
      setStale(true);
      setState((prev) => applyRaceFeedFailure(prev, Date.now()));
      return;
    }
    const before = stateRef.current;
    const next = applyRaceFeed(before, feed, Date.now());
    stateRef.current = next;
    setStale(false);
    setState(next);

    const changes = next.race && before.race ? placeChanges(before.race.rows, next.race.rows) : null;
    if (!changes || changes.size === 0) return;
    setMoves((prev) => {
      const marked = new Map(prev);
      for (const [rig, delta] of changes) {
        seq.current += 1;
        marked.set(rig, { delta, seq: seq.current });
      }
      return marked;
    });
    for (const rig of changes.keys()) {
      const pending = unmarkTimers.current.get(rig);
      if (pending) clearTimeout(pending);
      unmarkTimers.current.set(
        rig,
        setTimeout(() => {
          unmarkTimers.current.delete(rig);
          setMoves((current) => {
            const cleared = new Map(current);
            cleared.delete(rig);
            return cleared;
          });
        }, RACE_MOVE_HIGHLIGHT_MS),
      );
    }
  }, []);

  useVisiblePoll(refresh, RACE_POLL_MS, active);

  // The first answer should not wait a whole interval: a board that mounts
  // during a race shows it within one request. The feed is the external
  // system this effect subscribes to, and every setState in `refresh` sits
  // after its fetch resolves, not in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (active) void refresh();
  }, [active, refresh]);

  useEffect(() => {
    const timers = unmarkTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const finished =
    state.race !== null && state.finish !== null && state.finish.sessionKey === sessionKey(state.race);

  return { race: state.race, finished, moves, stale };
}
