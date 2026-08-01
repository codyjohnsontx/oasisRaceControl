import type { ComponentType } from "react";

/**
 * The `/tv` board-type seam.
 *
 * `/tv` is an unattended arcade high-score board: it cycles through a list of
 * slides forever with nobody touching it. This module defines the contract a
 * board type must satisfy to take part in that rotation, so a new kind of board
 * (league standings, rig status, an event countdown) can be added by writing one
 * definition and one line in the rotation builder - without touching the
 * rotation engine in `components/tv/tv-screen.tsx`.
 *
 * The three pieces:
 *
 *   1. `TvBoardDefinition` - a board type: how to load its data, how to tell
 *      whether it has anything worth showing, and the component that draws it.
 *   2. `TvSlide` - one entry in the rotation: which board type renders it plus
 *      that type's own spec (e.g. which track).
 *   3. The registry + rotation builder in `components/tv/board-types.tsx`, which
 *      is the single place that knows which board types exist and in what order
 *      they play.
 *
 * To add a board type:
 *   - write `const MY_BOARD = defineTvBoard<MySpec, MyData>({ ... })`
 *   - add it to `TV_BOARD_TYPES`
 *   - emit its slides from `buildRotation()`
 *
 * This module is import-safe from client components (types only, no DB).
 */

/** One entry in the rotation. */
export type TvSlide = {
  /**
   * Identity of this slide, unique across the whole rotation and stable across
   * rotation refreshes. The engine uses it to stay on the same board when the
   * list is re-read, and to key the slide-change animation.
   */
  key: string;
  /** Which `TV_BOARD_TYPES` entry renders this slide. */
  kind: string;
  /** Board-type-specific descriptor, passed straight back to that type. */
  spec: unknown;
};

/** Props every board component receives. */
export type TvBoardProps<TSpec, TData> = {
  spec: TSpec;
  data: TData;
  /**
   * True when the last refresh of this board failed and what's on screen is the
   * last known good data. Boards should stay readable and say so quietly rather
   * than blanking - the room shouldn't see an error page.
   */
  stale: boolean;
  /**
   * Ask the rotation to keep this board on screen for at least `ms` longer,
   * e.g. while playing a celebration. Advisory: the engine takes the longest
   * outstanding request and never shortens the normal hold.
   */
  hold: (ms: number) => void;
};

/** A board type: everything the rotation engine needs to play one kind of board. */
export type TvBoardDefinition<TSpec, TData> = {
  kind: string;
  /**
   * Load this slide's data. Must reject on failure (the engine treats a
   * rejection as "skip this slide and try the next one"), and must honour the
   * abort signal so a slide change cancels an in-flight request.
   */
  load: (spec: TSpec, signal: AbortSignal) => Promise<TData>;
  /**
   * False when there is nothing worth putting on the wall - an empty board is
   * skipped in the rotation instead of rendering as a blank screen.
   */
  hasContent: (data: TData) => boolean;
  Board: ComponentType<TvBoardProps<TSpec, TData>>;
};

/**
 * A definition with its spec and data types erased - what the registry and the
 * rotation engine hold. Board types are heterogeneous, so the registry can't be
 * typed over any one of them.
 */
export type AnyTvBoardDefinition = TvBoardDefinition<unknown, unknown>;

/**
 * Register a board type: checks `load`, `hasContent` and `Board` against each
 * other for one concrete spec and data type, then erases them for the registry.
 *
 * This is the only place the erasure cast lives. It is sound in practice
 * because the engine never mixes types - a slide's spec and the data loaded
 * from it are only ever handed back to the same board type, matched by `kind`.
 */
export function defineTvBoard<TSpec, TData>(
  definition: TvBoardDefinition<TSpec, TData>,
): AnyTvBoardDefinition {
  return definition as unknown as AnyTvBoardDefinition;
}
