/**
 * What one stored heartbeat says, as the rules read it. Times are epoch
 * milliseconds; `receivedAt` is the database's clock and the only one freshness
 * is judged by, while `sentAt` and `processStartedAt` are the rig's and are
 * used only to order the rig's own heartbeats against each other.
 *
 * Every field but `receivedAt` and `shuttingDown` is null for a v1 heartbeat,
 * which says nothing but its version; a rule that needs a field it lacks simply
 * does not fire on that rig.
 */
export type Heartbeat = {
  id: string;
  receivedAt: number;
  sentAt: number | null;
  /** received_at - sent_at: positive when the rig's clock is behind. */
  clockSkewMs: number | null;
  processStartedAt: number | null;
  /** The agent's own count, from 1, per process (`sequence` in events.ts). */
  sequence: number | null;
  agentVersion: string | null;
  telemetryMode: string | null;
  simConnected: boolean | null;
  telemetryFaulted: boolean | null;
  /** The session iRacing is in, in the strings laps are posted with; null when idle. */
  session: { trackName: string; trackConfig: string | null; carName: string } | null;
  pendingLaps: number | null;
  oldestPendingAgeS: number | null;
  rejectedLaps: number | null;
  checkout: string | null;
  missingVariables: string[];
  agentCpuPercent: number | null;
  agentMemoryMb: number | null;
  shuttingDown: boolean;
};

/**
 * True when `a` was demonstrably SENT before `b`, whatever order they arrived
 * in. Heartbeats can overtake each other on the network - a retry, or an
 * ordinary heartbeat already in flight when the goodbye went - so arrival
 * order alone would let a stale one overwrite a newer state.
 *
 * - Different processes: nothing is proved, so they are taken in arrival
 *   order. A new process restarts `sequence` at 1, and each names its start
 *   on the rig's clock, which can be stepped while an agent runs. A process
 *   sends its goodbye before it exits, so the next one cannot be overtaken by
 *   it.
 * - Same process with sequences: the lower sequence sent first. It is the
 *   agent's own counter, so it holds even if the rig's clock is corrected
 *   between the two.
 * - Otherwise the rig's `sentAt`, when both carry one.
 *
 * False when nothing proves an order, so a v1 heartbeat is taken in arrival
 * order as before.
 */
export function sentBefore(a: Heartbeat, b: Heartbeat): boolean {
  if (a.processStartedAt !== null && b.processStartedAt !== null) {
    if (a.processStartedAt !== b.processStartedAt) return false;
    if (a.sequence !== null && b.sequence !== null) return a.sequence < b.sequence;
  }
  if (a.sentAt !== null && b.sentAt !== null) return a.sentAt < b.sentAt;
  return false;
}

/**
 * The heartbeat that states a rig's current state: the latest one received,
 * except that a heartbeat sent before the one already standing never replaces
 * it. That is what keeps a clean shutdown a clean shutdown: an ordinary
 * heartbeat that was on the wire when the agent said goodbye lands after the
 * goodbye, and read by arrival it would say the rig came back and then went
 * silent - the very alert the goodbye exists to prevent.
 *
 * `heartbeats` is in arrival order (received_at, then id). Null when the rig
 * has none.
 */
export function rigState(heartbeats: readonly Heartbeat[]): Heartbeat | null {
  let state: Heartbeat | null = null;
  for (const heartbeat of heartbeats) {
    if (state === null || !sentBefore(heartbeat, state)) state = heartbeat;
  }
  return state;
}

/**
 * When the condition started holding without a break, judged by the rig's
 * heartbeats in arrival order up to and including `state`: the arrival time of
 * the earliest heartbeat in the unbroken run that ends at `state`. Null when
 * `state` itself does not satisfy it. A heartbeat that cannot say (a v1 one,
 * or a field the agent left out) breaks the run, so a condition is never
 * assumed to have held through a stretch nobody reported on.
 */
export function holdingSince(
  heartbeats: readonly Heartbeat[],
  state: Heartbeat,
  holds: (heartbeat: Heartbeat) => boolean,
): number | null {
  if (!holds(state)) return null;
  const end = heartbeats.indexOf(state);
  let since = state.receivedAt;
  for (let i = end - 1; i >= 0; i--) {
    const heartbeat = heartbeats[i]!;
    if (heartbeat.shuttingDown || !holds(heartbeat)) break;
    since = heartbeat.receivedAt;
  }
  return since;
}
