import { formatLapTime } from "@/lib/time";
import { VENUE_TIMEZONE } from "@/lib/venue";
import type { UnattributedLapRow } from "@/lib/unattributed-laps";
import { describeUnattributedCause } from "@/lib/unattributed-cause";

/**
 * Staff read these times against the venue clock and against a customer saying
 * "about nine". Pinned to the venue zone and an explicit locale rather than the
 * runtime default, which is UTC on the server and the browser's zone on the
 * tablet - so an unpinned format renders one time on first paint and a different
 * one after hydration.
 */
const unclaimedAt = new Intl.DateTimeFormat("en-US", {
  timeZone: VENUE_TIMEZONE,
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * The `/staff` list of laps nobody can be credited with, and why each one is
 * there. Read-only: attributing one to a driver is deliberately not built (see
 * the SAFETY NOTE in db/migrations/0003).
 *
 * No hooks and no router, so the rows can be rendered to markup in a test
 * without a browser. Renders nothing when the window is empty - the section is
 * a diagnostic, and an empty diagnostic is noise on a busy screen.
 */
export function UnclaimedLaps({
  laps,
  total,
}: {
  laps: UnattributedLapRow[];
  /** Unclaimed laps in the whole window, which may be more than are listed. */
  total: number;
}) {
  if (laps.length === 0) return null;

  return (
    <section>
      <h2 className="text-muted font-bold uppercase tracking-wider text-sm mb-3">
        Unclaimed laps · last 7 days
      </h2>
      <p className="text-muted text-xs mb-3">
        Laps nobody can be credited with. They are kept but can never reach a
        leaderboard. Each row says why. <em>Rig saw no check-in</em>{" "}
        usually means the customer drove before scanning; it can also be a
        check-in the rig had not heard about yet - it asks every 10 seconds,
        and cannot while offline. Nothing needs fixing either way. Any other
        reason is the rig&apos;s, and that rig needs looking at - an agent
        build too old to say who was driving, a check-in this rig has never
        had, or a finish time outside the check-in it names, which means the
        rig PC&apos;s clock has drifted or the rig was offline while the seat
        changed hands. The exception is{" "}
        <em>Cause not recorded</em>: those laps were stored before this screen
        could say why, and there is nothing to act on.
      </p>
      <p className="text-muted text-xs mb-3">
        If a customer says their laps are missing, find them here by rig and
        time. If they were checked in, this was not their mistake.
      </p>
      <div className="flex flex-col">
        {laps.map((lap) => {
          const cause = describeUnattributedCause(lap.unattributed_cause);
          return (
            <div
              key={lap.id}
              className="flex items-center gap-3 border-b border-edge py-2 text-sm opacity-60"
            >
              <span className="laptime font-bold w-20">
                {formatLapTime(lap.lap_time_ms)}
              </span>
              <span className="text-muted w-32 truncate">
                {unclaimedAt.format(new Date(lap.completed_at))}
              </span>
              <span className="text-muted w-12">
                {lap.rig_number
                  ? `R${lap.rig_number.toString().padStart(2, "0")}`
                  : "—"}
              </span>
              <span className="text-muted flex-1 truncate">
                {lap.track_name}
                {lap.track_config ? ` (${lap.track_config})` : ""} · {lap.car_name}
              </span>
              <span
                className={`w-44 shrink-0 text-right text-[10px] uppercase font-bold leading-tight ${
                  cause.rigNeedsAttention ? "text-invalid" : "text-muted"
                }`}
              >
                {cause.label}
              </span>
            </div>
          );
        })}
      </div>
      {total > laps.length && (
        <p className="text-muted text-xs mt-3">
          Showing the {laps.length} most recent of {total} unclaimed laps in the
          last 7 days. The rest are stored but not listed here.
        </p>
      )}
    </section>
  );
}
