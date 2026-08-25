/**
 * Why a lap has no owner: the `unattributed_cause` enum from
 * db/migrations/0004_unattributed_cause.sql, and the words `/staff` shows for
 * each value.
 *
 * Ingestion decides the first four (`attributeLap` in
 * app/api/agent/events/route.ts) and stores exactly the label it decided.
 * `not_recorded` is the one label ingestion never writes: the migration
 * backfills it onto laps stored before the column existed.
 *
 * Pure, so a client component can import it. The wording is venue-facing: a
 * person at the counter reads it next to a lap time, and what they need from it
 * is whether this is the customer's explanation or a rig that needs attention.
 * It lives here and nowhere else, so the screen and the tests agree on it by
 * construction.
 */
export const UNATTRIBUTED_CAUSES = [
  "nobody_checked_in",
  "agent_sends_no_assignment_id",
  "unknown_assignment",
  "outside_assignment_window",
  "not_recorded",
] as const;

export type UnattributedCause = (typeof UNATTRIBUTED_CAUSES)[number];

export type UnattributedCauseWording = {
  /** Short enough to end a lap row. */
  label: string;
  /**
   * Whether somebody has to go and look at the rig. The three causes the
   * ingestion route logs as abnormal are the three that do. False for the
   * ordinary case, and for a cause nobody recorded - there is nothing to act on
   * either way.
   */
  rigNeedsAttention: boolean;
};

const WORDING: Record<UnattributedCause, UnattributedCauseWording> = {
  nobody_checked_in: {
    label: "Drove before scanning",
    rigNeedsAttention: false,
  },
  agent_sends_no_assignment_id: {
    label: "Rig agent out of date",
    rigNeedsAttention: true,
  },
  unknown_assignment: {
    label: "Unknown assignment",
    rigNeedsAttention: true,
  },
  // One cause, two possible rig faults: the server cannot tell a drifted clock
  // from a rig that was offline while the seat changed hands, so the label
  // names both rather than guessing.
  outside_assignment_window: {
    label: "Rig clock out of sync, or offline at handover",
    rigNeedsAttention: true,
  },
  not_recorded: {
    label: "Cause not recorded",
    rigNeedsAttention: false,
  },
};

export function describeUnattributedCause(
  cause: UnattributedCause,
): UnattributedCauseWording {
  return WORDING[cause];
}
