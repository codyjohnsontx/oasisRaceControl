import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UnclaimedLaps } from "./unclaimed-laps";
import type { UnattributedLapRow } from "@/lib/unattributed-laps";
import type { UnattributedCause } from "@/lib/unattributed-cause";

/**
 * What a person at the counter sees per unclaimed lap. Rendered to static
 * markup rather than mounted: the component has no state, so the HTML string
 * is the whole behaviour, and no browser or DOM shim has to be installed to
 * assert on it.
 */

let sequence = 0;

function lap(cause: UnattributedCause): UnattributedLapRow {
  sequence += 1;
  return {
    id: `lap-${sequence}`,
    lap_time_ms: 90_000 + sequence,
    track_name: "Spa-Francorchamps",
    track_config: "Grand Prix Pits",
    car_name: "Porsche 911 GT3 R",
    completed_at: "2026-08-25T02:00:00.000Z",
    rig_number: sequence,
    unattributed_cause: cause,
  };
}

/** The class list of the span that carries `label`, or null if none does. */
function causeSpanClass(html: string, label: string): string | null {
  const match = html.match(new RegExp(`<span class="([^"]*)">${label}</span>`));
  return match?.[1] ?? null;
}

describe("UnclaimedLaps", () => {
  it("says on each row why the lap is unclaimed, in the venue's words", () => {
    const html = renderToStaticMarkup(
      <UnclaimedLaps
        laps={[
          lap("nobody_checked_in"),
          lap("agent_sends_no_assignment_id"),
          lap("unknown_assignment"),
          lap("outside_assignment_window"),
          lap("not_recorded"),
        ]}
        total={5}
      />,
    );

    expect(html).toContain("Rig saw no check-in");
    expect(html).toContain("Rig agent out of date");
    expect(html).toContain("Unknown assignment");
    expect(html).toContain("Rig clock out of sync, or offline at handover");
    expect(html).toContain("Cause not recorded");
    // The enum labels never reach the screen.
    expect(html).not.toMatch(/nobody_checked_in|outside_assignment_window/);
  });

  it("colours a rig problem as a problem and the ordinary case as ordinary", () => {
    const html = renderToStaticMarkup(
      <UnclaimedLaps
        laps={[lap("nobody_checked_in"), lap("outside_assignment_window")]}
        total={2}
      />,
    );

    expect(causeSpanClass(html, "Rig saw no check-in")).toContain("text-muted");
    expect(causeSpanClass(html, "Rig saw no check-in")).not.toContain("text-invalid");
    expect(
      causeSpanClass(html, "Rig clock out of sync, or offline at handover"),
    ).toContain("text-invalid");
  });

  it("keeps the showing-N-of-M note when the window holds more than the list", () => {
    const html = renderToStaticMarkup(
      <UnclaimedLaps laps={[lap("nobody_checked_in"), lap("nobody_checked_in")]} total={41} />,
    );

    expect(html).toContain("Showing the 2 most recent of 41 unclaimed laps");
  });

  it("omits that note when the whole window is listed", () => {
    const html = renderToStaticMarkup(
      <UnclaimedLaps laps={[lap("nobody_checked_in")]} total={1} />,
    );

    expect(html).not.toContain("most recent of");
  });

  it("renders nothing when nothing is unclaimed", () => {
    expect(renderToStaticMarkup(<UnclaimedLaps laps={[]} total={0} />)).toBe("");
  });
});
