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
  /**
   * Walk-up sign-ins refused since the agent's last delivered heartbeat, and
   * their kinds (SIGN_IN_FAILURE_KINDS in events.ts; the route refuses any
   * other value).
   */
  signInFailures: number | null;
  signInFailureKinds: string[];
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
 * The rig's heartbeats in the order they were SENT: arrival order, corrected
 * wherever `sentBefore` proves one heartbeat left the rig before another that
 * arrived ahead of it. Every rule that asks "the latest", "the latest live" or
 * "since when" reads this one order, so a late heartbeat with a lower sequence
 * can never stand in for newer state - not as the rig's state, not as its last
 * live report after a goodbye, and not inside a duration.
 *
 * `heartbeats` is in arrival order (received_at, then id).
 */
export function inSendOrder(heartbeats: readonly Heartbeat[]): Heartbeat[] {
  const ordered: Heartbeat[] = [];
  for (const heartbeat of heartbeats) {
    const later = ordered.findIndex((other) => sentBefore(heartbeat, other));
    if (later === -1) ordered.push(heartbeat);
    else ordered.splice(later, 0, heartbeat);
  }
  return ordered;
}

/**
 * The heartbeat that states a rig's current state: the last one sent. That is
 * what keeps a clean shutdown a clean shutdown: an ordinary heartbeat that was
 * on the wire when the agent said goodbye lands after the goodbye, and read by
 * arrival it would say the rig came back and then went silent - the very
 * alert the goodbye exists to prevent. Null when the rig has none.
 */
export function rigState(heartbeats: readonly Heartbeat[]): Heartbeat | null {
  return inSendOrder(heartbeats).at(-1) ?? null;
}

/**
 * The last heartbeat sent that satisfies `matches`, in send order.
 */
export function lastSent(
  heartbeats: readonly Heartbeat[],
  matches: (heartbeat: Heartbeat) => boolean,
): Heartbeat | null {
  return inSendOrder(heartbeats).findLast(matches) ?? null;
}

/**
 * When the condition started holding without a break, judged by the rig's
 * heartbeats in send order up to and including `state`: the earliest arrival
 * in the unbroken run that ends at `state`. Null when `state` itself does not
 * satisfy it. A heartbeat that cannot say (a v1 one, or a field the agent left
 * out) or a goodbye breaks the run, so a condition is never assumed to have
 * held through a stretch nobody reported on.
 */
export function holdingSince(
  heartbeats: readonly Heartbeat[],
  state: Heartbeat,
  holds: (heartbeat: Heartbeat) => boolean,
): number | null {
  if (!holds(state)) return null;
  const ordered = inSendOrder(heartbeats);
  const end = ordered.indexOf(state);
  let since = state.receivedAt;
  for (let i = end - 1; i >= 0; i--) {
    const heartbeat = ordered[i]!;
    if (heartbeat.shuttingDown || !holds(heartbeat)) break;
    since = Math.min(since, heartbeat.receivedAt);
  }
  return since;
}
