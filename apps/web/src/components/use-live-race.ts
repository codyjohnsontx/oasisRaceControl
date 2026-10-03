"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveRace } from "@/lib/race-live";
import {
  INITIAL_RACE_BOARD,
  RACE_FEED_TIMEOUT_MS,
  RACE_MOVE_HIGHLIGHT_MS,
  RACE_POLL_MS,
  applyRaceFeed,
  applyRaceFeedFailure,
  placeChanges,
  sessionKey,
  type RaceBoardState,
  type RaceMove,
} from "@/lib/race-board";
import { createRaceFeedPoller, type RaceFeedPoller } from "./race-feed-poller";
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
 *
 * The requests themselves go through `createRaceFeedPoller`: one at a time,
 * each bounded by RACE_FEED_TIMEOUT_MS, and a timed-out one counts as a failed
 * one, so a slow route cannot stack requests from every screen in the venue
 * and a hung one cannot leave a finished race on the wall as if it were live.
 * The request in flight is aborted when polling stops - the round closed, the
 * screen unmounted - and reports nothing.
 *
 * Move marks belong to one race: when the race leaves the screen or the feed
 * turns to another session, every mark is cleared at once rather than left
 * to time out over the next race's grid.
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

  const clearMoves = useCallback(() => {
    for (const timer of unmarkTimers.current.values()) clearTimeout(timer);
    unmarkTimers.current.clear();
    setMoves((current) => (current.size === 0 ? current : new Map()));
  }, []);

  const applyFeed = useCallback(
    (feed: LiveRace) => {
      const before = stateRef.current;
      const next = applyRaceFeed(before, feed, Date.now());
      stateRef.current = next;
      setStale(false);
      setState(next);

      const continuous =
        next.race !== null && before.race !== null && sessionKey(before.race) === sessionKey(next.race);
      if (!continuous) {
        clearMoves();
        return;
      }
      const changes = placeChanges(before.race, next.race!);
      if (changes.size === 0) return;
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
    },
    [clearMoves],
  );

  const applyFailure = useCallback(() => {
    setStale(true);
    setState((prev) => applyRaceFeedFailure(prev, Date.now()));
  }, []);

  // One poller for the life of the hook; the callbacks it reports through
  // are stable, so it is never rebuilt with a request in flight.
  const poller = useRef<RaceFeedPoller | null>(null);
  poller.current ??= createRaceFeedPoller({
    fetch: (...args) => fetch(...args),
    timeoutMs: RACE_FEED_TIMEOUT_MS,
    onFeed: applyFeed,
    onFailure: applyFailure,
  });

  const refresh = useCallback(() => {
    void poller.current?.poll();
  }, []);

  useVisiblePoll(refresh, RACE_POLL_MS, active);

  // The first answer should not wait a whole interval: a board that mounts
  // during a race shows it within one request. And when polling stops, the
  // request in flight is abandoned with it.
  useEffect(() => {
    if (!active) return;
    refresh();
    return () => poller.current?.stop();
  }, [active, refresh]);

  useEffect(() => {
    const timers = unmarkTimers.current;
    const current = poller.current;
    return () => {
      current?.stop();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const finished =
    state.race !== null && state.finish !== null && state.finish.sessionKey === sessionKey(state.race);

  return { race: state.race, finished, moves, stale };
}
