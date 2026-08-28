import { describe, expect, it } from "vitest";
import {
  UNATTRIBUTED_CAUSES,
  describeUnattributedCause,
  type UnattributedCause,
} from "./unattributed-cause";

describe("describeUnattributedCause", () => {
  it("has venue wording for every cause the database can hold", () => {
    for (const cause of UNATTRIBUTED_CAUSES) {
      const wording = describeUnattributedCause(cause);
      expect(wording.label.length).toBeGreaterThan(0);
      // A person reads this next to a lap time; the enum label is not it.
      expect(wording.label).not.toContain("_");
    }
  });

  it("says what the rig knew for the ordinary case, without blaming the customer", () => {
    // The agent stamps from its last successful poll, so this label also covers
    // a check-in the rig had not heard about yet. The wording claims only that.
    expect(describeUnattributedCause("nobody_checked_in")).toEqual({
      label: "Rig saw no check-in",
      rigNeedsAttention: false,
    });
  });

  it("flags exactly the causes the ingestion route logs as abnormal", () => {
    // warnAboutAbnormalCauses (app/api/agent/events/route.ts) warns about
    // three of the four; those three are the ones that send somebody to a rig.
    const flagged = UNATTRIBUTED_CAUSES.filter(
      (cause) => describeUnattributedCause(cause).rigNeedsAttention,
    );
    expect(flagged).toEqual([
      "agent_sends_no_assignment_id",
      "unknown_assignment",
      "outside_assignment_window",
    ]);
  });

  it("does not send anyone to a rig over a cause nobody recorded", () => {
    // Laps stored before 0004 kept no cause. Any of the four could have
    // applied, so the honest reading is unknown, not a rig fault.
    expect(describeUnattributedCause("not_recorded").rigNeedsAttention).toBe(false);
  });

  it("words a label this build has never heard of instead of returning nothing", () => {
    // Migrate runs before deploy (docs/deploy.md), so a migration that adds a
    // sixth label is live while the previous deployment is still serving. That
    // build reads the new label here. Returning undefined for it makes the
    // caller's first property read throw and takes the whole /staff page down
    // over one row, so an unknown label gets neutral words instead. The cast is
    // the point: the parameter type is a claim about the database that the
    // deploy order can outlive.
    const wording = describeUnattributedCause(
      "rig_rejected_lap" as UnattributedCause,
    );

    expect(wording.label).toBe("Cause not recognised");
    // Nobody is sent to a rig over a label we cannot read.
    expect(wording.rigNeedsAttention).toBe(false);
  });
});
