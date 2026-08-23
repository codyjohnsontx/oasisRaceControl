import type { z } from "zod";
import type { simHealth } from "./events";

export type SimHealth = z.infer<typeof simHealth>;

/** How a rig's simulator reading should read on the staff dashboard. */
export type RigSimStatus = {
  /** `bad` is the only one worth a colour: this rig is up and not scoring. */
  tone: "bad" | "quiet";
  label: string;
  /** The agent's own words - which channels are missing. Null unless `bad`. */
  detail: string | null;
};

/** How a rig's installation conflict should read on the staff dashboard. */
export type RigTokenStatus = {
  /** Null when there is nothing to say - the ordinary case for every rig. */
  label: string | null;
  /** Which two computers, in the agent's own words. */
  detail: string | null;
};

/**
 * Turns "two computers are using this rig's token" into what staff should read.
 *
 * This one is worth interrupting somebody for in a way an offline rig is not.
 * The rig looks fine - it is online, it is heartbeating, the customer on it is
 * driving - and the backend is holding every lap from BOTH machines because it
 * cannot tell whose customer drove which. Nothing about the room shows it, and
 * no amount of waiting fixes it: somebody has to give the second machine its own
 * token. Naming the two computers is what turns that into a two-minute job.
 *
 * @param conflict whether the database still counts the clash as live
 * @param detail the two machine names, as the heartbeats reported them
 */
export function describeRigToken(
  conflict: boolean,
  detail: string | null,
): RigTokenStatus {
  if (!conflict) return { label: null, detail: null };
  return { label: "token shared", detail };
}

/**
 * Turns a rig's last reported simulator health into what staff should read.
 *
 * The case this exists for: a rig that is online, heartbeating, and cannot keep
 * a lap looks exactly like a rig between customers. Everything else here is
 * about not crying wolf around that one line - an idle rig with iRacing closed
 * is the normal state of most of the room for most of the day, and a rig nobody
 * has heard from is already reported as offline.
 *
 * @param health what the agent last reported, or null from an agent too old to say
 * @param detail the agent's explanation, only meaningful for `unreadable`
 * @param online whether the agent has been heard from recently at all
 */
export function describeRigSim(
  health: SimHealth | null,
  detail: string | null,
  online: boolean,
): RigSimStatus {
  // A reading from a rig that has since gone quiet is not a reading. Showing the
  // last one would put "sim ready" on a machine that may have been switched off
  // an hour ago, and "not scoring" on one nobody can do anything about yet.
  if (!online) return { tone: "quiet", label: "sim unknown", detail: null };

  switch (health) {
    case "unreadable":
      return { tone: "bad", label: "not scoring", detail };
    case "scoring":
      return { tone: "quiet", label: "sim ready", detail: null };
    case "no_sim":
      return { tone: "quiet", label: "sim closed", detail: null };
    default:
      // An agent from before rigs reported this. Silence is not health, so it
      // says unknown rather than borrowing either of the calm answers.
      return { tone: "quiet", label: "sim unknown", detail: null };
  }
}

/** What the room is running, and which machines an update round has not reached. */
export type FleetBuild = {
  /**
   * The newest build any rig has reported - what a half-finished update round is
   * rolling out. Null until at least one rig names a comparable build.
   */
  newest: string | null;
  /** How many rigs are on it, out of how many have ever reported a build. */
  onNewest: number;
  reporting: number;
};

/**
 * Reads a fleet update round off the versions the rigs themselves report.
 *
 * Updating the agent is a walk round twenty-plus machines with a USB stick, and
 * the trigger is not optional: iRacing updates are forced, the whole venue takes
 * the same one within a day, and a build that cannot read the new telemetry
 * layout stops every rig scoring together. Halfway through that walk the only
 * question is which machines are done, and "I think I did that one" is not an
 * answer at twenty-two.
 *
 * The target build is deliberately not configured anywhere: it is the newest one
 * any rig has reported. Nothing has to be told a release happened - copying the
 * new build onto the first rig sets the target, and every other machine reads as
 * behind until it has been walked to. It also covers the case nobody plans for,
 * a rig quietly left on an old build long after the round was finished.
 *
 * Offline rigs count. A machine switched off at the wall still needs the update,
 * and a rig that took one before being switched off still proves the build exists.
 */
export function describeFleetBuild(
  versions: readonly (string | null)[],
): FleetBuild {
  const reported = versions.filter((v): v is string => (v ?? "").trim() !== "");
  let newest: string | null = null;
  for (const version of reported) {
    if (!isComparableBuild(version)) continue;
    if (newest === null || compareBuilds(version, newest) > 0) newest = version;
  }
  return {
    newest,
    // Counted the same way a card decides it is not behind, so the summary line and
    // the tiles under it can never disagree about the same rig.
    onNewest:
      newest === null
        ? 0
        : reported.filter((v) => !describeRigBuild(v, newest).behind).length,
    reporting: reported.length,
  };
}

/**
 * Whether one rig is behind the build the fleet is rolling out.
 *
 * A rig that has never reported a build is not "behind" - the card already says
 * `no agent`, and a second label on the same tile says nothing new. A rig whose
 * build cannot be compared to the newest one (a hand-built binary, an agent old
 * enough to predate version numbers) is reported as unknown rather than assumed
 * current: an update round that quietly skips a machine is the failure here.
 */
export function describeRigBuild(
  version: string | null,
  newest: string | null,
): { label: string | null; behind: boolean } {
  if ((version ?? "").trim() === "" || newest === null) return { label: null, behind: false };
  if (version === newest) return { label: null, behind: false };
  if (!isComparableBuild(version!)) return { label: "build unknown", behind: true };
  return compareBuilds(version!, newest) < 0
    ? { label: "update pending", behind: true }
    : { label: null, behind: false };
}

/**
 * The version by itself, for a line that already says it is a build.
 * A rig reports `oasis-rig-agent/0.5.0`; a dashboard reading `0.5.0` next to
 * twenty-one others is what an operator compares at a glance.
 */
export function shortBuild(version: string): string {
  return version.slice(version.lastIndexOf("/") + 1);
}

/**
 * Orders two reported builds.
 *
 * Compares the version's numbers, never its text: the fleet will run `0.9.0` and
 * `0.10.0` at the same time during a round, and by text the older one wins - so
 * every updated rig would read as behind and the round would look untouched.
 * Numbers are compared component by component with a missing component read as
 * zero, so `0.5` and `0.5.0` are the same build.
 */
function compareBuilds(a: string, b: string): number {
  const left = buildNumbers(a);
  const right = buildNumbers(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function isComparableBuild(version: string): boolean {
  return buildNumbers(version).length > 0;
}

/**
 * The numbers in a reported build. `oasis-rig-agent/0.5.0` is the shape a rig
 * sends; the product name in front of it is dropped, and anything after the
 * numbers (`0.1-skeleton`, a pre-release suffix) is not ordered - it would take a
 * semver comparison to do honestly, and this only has to tell an updated rig from
 * one that has not been walked to yet.
 */
function buildNumbers(version: string): number[] {
  const trailing = version.slice(version.lastIndexOf("/") + 1).trim();
  const numbers = /^(\d+(?:\.\d+)*)/.exec(trailing);
  return numbers ? numbers[1].split(".").map(Number) : [];
}
