import { redirect } from "next/navigation";
import { StaffRigHealth, type RigHealthAlert } from "@/components/staff-rig-health";
import { boardName, boardState, boardsToday, eventMode } from "@/lib/monitor/event-mode";
import { REPOSITORY } from "@/lib/monitor/handoff";
import { eventModeLine, venueDate, venueTime } from "@/lib/monitor/messages";
import { problems, rigTiles } from "@/lib/monitor/rig-health";
import { duration, evaluateRules, flapScope, rigSubject, RULES } from "@/lib/monitor/rules";
import {
  lastLapAtByRig,
  loadSnapshot,
  monitorClock,
  recentAlerts,
  type RecentAlert,
} from "@/lib/monitor/store";
import { db } from "@/lib/db";
import { getStaffUser } from "@/lib/staff";

/**
 * Rig health: one tile per rig, event mode, and the monitor's alerts. It reads
 * the snapshot the monitor reads and calls the same evaluateRules on it, so a
 * tile is red exactly when the channel has been (or is about to be) told
 * something urgent about that rig. It only reads - an evaluation that posts
 * is the "Run checks now" button's job, throttled with every other one.
 */
export default async function RigHealthPage() {
  const staff = await getStaffUser();
  if (!staff) redirect("/staff/login");

  // Failures throw to the error boundary: an empty page that is really a
  // failed query would read as a venue with nothing wrong.
  const clock = await monitorClock();
  const [snapshot, lastLaps, alerts] = await Promise.all([
    loadSnapshot(db(), clock.now),
    lastLapAtByRig(),
    recentAlerts(),
  ]);
  const findings = evaluateRules(snapshot);
  const { now } = snapshot;
  const mode = eventMode(snapshot);
  // Everything else - the venue, the TV boards - is listed above the tiles.
  const rigSubjects = new Set(snapshot.rigs.map((rig) => rigSubject(rig.id)));

  return (
    <StaffRigHealth
      staffName={staff.displayName}
      tiles={rigTiles(snapshot, findings, lastLaps)}
      venueProblems={problems(findings.filter((f) => !rigSubjects.has(flapScope(f.subject))))}
      event={{
        on: mode.on,
        // The channel's own wording, less its "⚪ Event mode on:" - the page shows on or off beside it.
        line: eventModeLine(mode).replace(/^.*?Event mode (on|off): /, ""),
        override: mode.cause === "override" ? (mode.on ? "on" : "off") : null,
      }}
      boards={boardsToday(snapshot).map((b) => {
        const state = boardState(b, now);
        return {
          id: b.id,
          name: boardName(b),
          state,
          detail:
            state === "live"
              ? b.feedFailures > 0
                ? `feed failing (${b.feedFailures} in a row)`
                : "feed ok"
              : `last heard ${duration(now - b.lastSeenAt)} ago`,
        };
      })}
      checks={
        clock.lastEvaluatedAt === null
          ? "Checks have never run"
          : `Checks last ran ${duration(now - clock.lastEvaluatedAt)} ago`
      }
      alerts={alerts.map((a) => alertRow(a, now))}
    />
  );
}

function alertRow(alert: RecentAlert, now: number): RigHealthAlert {
  const rule = RULES[alert.rule as keyof typeof RULES];
  return {
    id: alert.id,
    severity: alert.severity,
    rule: rule ? `Rule ${rule.number}` : alert.rule,
    where: alert.where,
    headline: alert.headline,
    opened: stamp(alert.openedAt, now),
    recovered: alert.resolvedAt === null ? null : stamp(alert.resolvedAt, now),
    muted: alert.muted,
    issue:
      alert.githubIssueNumber === null
        ? null
        : {
            number: alert.githubIssueNumber,
            href: `https://github.com/${REPOSITORY}/issues/${alert.githubIssueNumber}`,
          },
  };
}

/** "3:40 PM" today, "Oct 4 3:40 PM" before. */
function stamp(at: number, now: number): string {
  return venueDate(at) === venueDate(now) ? venueTime(at) : `${venueDate(at)} ${venueTime(at)}`;
}
