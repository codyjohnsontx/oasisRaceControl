import { describe, expect, it } from "vitest";
import { UNATTRIBUTED_CAUSES, describeUnattributedCause } from "./unattributed-cause";

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
});
