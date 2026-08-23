import { describe, expect, it } from "vitest";
import {
  describeFleetBuild,
  describeRigBuild,
  describeRigSim,
  describeRigToken,
} from "./rig-health";

describe("rig simulator health on the staff dashboard", () => {
  it("flags a rig that is up and cannot score, in the agent's own words", () => {
    const status = describeRigSim(
      "unreadable",
      "the simulator does not publish OnPitRoad",
      true,
    );
    expect(status.tone).toBe("bad");
    expect(status.detail).toContain("OnPitRoad");
  });

  it("leaves an idle rig with its sim closed alone", () => {
    // Most of the room, most of the day. Colouring this would train staff to
    // ignore the one line that matters.
    expect(describeRigSim("no_sim", null, true).tone).toBe("quiet");
  });

  it("says nothing is wrong with a rig that is scoring", () => {
    expect(describeRigSim("scoring", null, true)).toEqual({
      tone: "quiet",
      label: "sim ready",
      detail: null,
    });
  });

  it("does not read silence as health", () => {
    // An agent from before rigs reported this. Showing it as fine would be a
    // guess about twenty machines.
    expect(describeRigSim(null, null, true).label).toBe("sim unknown");
    expect(describeRigSim(null, null, true).tone).toBe("quiet");
  });

  it("stops reporting a reading from a rig nobody has heard from", () => {
    // The rig is already shown as offline; its last verdict is however old that
    // is, and "not scoring" on a machine that may be switched off sends whoever
    // is on shift across the room for nothing.
    const stale = describeRigSim("unreadable", "the simulator does not publish Lap", false);
    expect(stale.tone).toBe("quiet");
    expect(stale.detail).toBeNull();
    expect(stale.label).toBe("sim unknown");
  });
});

describe("describeRigToken", () => {
  it("says nothing at all for the ordinary rig", () => {
    // Twenty of twenty-one cards must carry no extra line, or the one that
    // matters is not the one that gets read.
    expect(describeRigToken(false, null)).toEqual({ label: null, detail: null });
    expect(describeRigToken(false, "RIG-03 and RIG-07")).toEqual({
      label: null,
      detail: null,
    });
  });

  it("names the two computers, because that is what makes it a two-minute job", () => {
    const clash = describeRigToken(true, "RIG-03 and RIG-07");
    expect(clash.label).toBe("token shared");
    expect(clash.detail).toBe("RIG-03 and RIG-07");
  });

  it("still raises it when neither machine reported a name", () => {
    // An older agent, or a machine with no usable name. Losing the whole warning
    // because the explanation is missing would leave laps held with nothing on
    // screen to explain it.
    const clash = describeRigToken(true, null);
    expect(clash.label).toBe("token shared");
    expect(clash.detail).toBeNull();
  });
});

describe("which machines an agent update round has reached", () => {
  const NEW = "oasis-rig-agent/0.5.0";
  const OLD = "oasis-rig-agent/0.4.0";

  it("takes the build being rolled out from the rigs themselves", () => {
    // Nothing is configured with a release: copying the new build onto the first
    // rig of the round is what sets the target for the other twenty-one.
    const fleet = describeFleetBuild([NEW, OLD, OLD, OLD]);
    expect(fleet.newest).toBe(NEW);
    expect(fleet.onNewest).toBe(1);
    expect(fleet.reporting).toBe(4);
  });

  it("says nothing about a fleet that is all on one build", () => {
    const fleet = describeFleetBuild([NEW, NEW, NEW]);
    expect(fleet.onNewest).toBe(3);
    expect(describeRigBuild(NEW, fleet.newest).label).toBeNull();
  });

  it("marks the machines still to walk to", () => {
    expect(describeRigBuild(OLD, NEW)).toEqual({ label: "update pending", behind: true });
  });

  it("orders builds by number, not by text", () => {
    // 0.10.0 follows 0.9.0, and by text it does not. Getting this wrong during a
    // round reads as every updated rig being behind - the round looks untouched.
    const fleet = describeFleetBuild(["oasis-rig-agent/0.9.0", "oasis-rig-agent/0.10.0"]);
    expect(fleet.newest).toBe("oasis-rig-agent/0.10.0");
    expect(describeRigBuild("oasis-rig-agent/0.9.0", fleet.newest).behind).toBe(true);
    expect(describeRigBuild("oasis-rig-agent/0.10.0", fleet.newest).behind).toBe(false);
  });

  it("counts a rig that shipped before version numbers as one to update", () => {
    // The build that reported "rig-agent/0.1-skeleton" whatever was installed.
    const fleet = describeFleetBuild([NEW, "rig-agent/0.1-skeleton"]);
    expect(fleet.newest).toBe(NEW);
    expect(describeRigBuild("rig-agent/0.1-skeleton", fleet.newest).behind).toBe(true);
  });

  it("never lets a build it cannot read set the target for the room", () => {
    // A hand-built binary on one machine must not make the other twenty-one look
    // out of date - but it is not silently current either, because a round that
    // skips a machine is the failure this is for.
    const fleet = describeFleetBuild([NEW, NEW, "bench-build"]);
    expect(fleet.newest).toBe(NEW);
    expect(fleet.onNewest).toBe(2);
    expect(describeRigBuild("bench-build", fleet.newest)).toEqual({
      label: "build unknown",
      behind: true,
    });
  });

  it("says nothing at all about a room where no build can be read", () => {
    // Every rig on a hand-built binary. Picking one of them as the target would
    // mark the whole room as behind a build that is itself unreadable.
    const fleet = describeFleetBuild(["bench-build", "dev", "bench-build"]);
    expect(fleet.newest).toBeNull();
    expect(describeRigBuild("dev", fleet.newest)).toEqual({ label: null, behind: false });
  });

  it("leaves a rig that has never reported a build alone", () => {
    // Its card already says "no agent". A second label on the same tile is noise.
    expect(describeRigBuild(null, NEW)).toEqual({ label: null, behind: false });
    expect(describeRigBuild("", NEW).label).toBeNull();
    expect(describeFleetBuild([null, null]).newest).toBeNull();
    expect(describeFleetBuild([]).newest).toBeNull();
  });

  it("says nothing until a build is known", () => {
    expect(describeRigBuild(OLD, null)).toEqual({ label: null, behind: false });
  });

  it("reads 0.5 and 0.5.0 as the same build", () => {
    expect(describeRigBuild("oasis-rig-agent/0.5", "oasis-rig-agent/0.5.0").behind).toBe(false);
  });
});
