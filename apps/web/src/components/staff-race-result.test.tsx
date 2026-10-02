import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StaffRaceResult } from "./staff-race-result";
import type { RaceReview, RaceReviewEntry } from "@/lib/league";

/**
 * What staff see of tonight's race result before closing the round. Rendered
 * to static markup: the review's first paint is the part that has to make a
 * missing or doubtful place impossible to overlook.
 */

function entry(name: string, change: Partial<RaceReviewEntry> = {}): RaceReviewEntry {
  return {
    driver_id: `driver-${name}`,
    display_name: name,
    finish_position: 1,
    source: "flag",
    rig_number: 1,
    laps_completed: 12,
    ...change,
  };
}

function render(review: RaceReview): string {
  return renderToStaticMarkup(
    <StaffRaceResult review={review} busy={false} onSave={async () => true} />,
  );
}

describe("StaffRaceResult", () => {
  it("says there is no race yet, and offers a hand entry once the round has drivers", () => {
    const empty = render({ raceHeard: false, confirmed: false, entries: [], notInRace: [] });
    expect(empty).toContain("No race yet");
    expect(empty).not.toContain("Enter result by hand");

    const withField = render({
      raceHeard: true,
      confirmed: false,
      entries: [],
      notInRace: [{ driver_id: "d", display_name: "Dee" }],
    });
    expect(withField).toContain("Race on - places record at the flag");
    expect(withField).toContain("Enter result by hand");
  });

  it("lists the captured order as the round will place it, with where each place came from", () => {
    const html = render({
      raceHeard: true,
      confirmed: false,
      entries: [
        entry("Ana", { finish_position: 1, rig_number: 3 }),
        // iRacing's P3 is the venue's second: P2 was a car nobody signed in to.
        entry("Ben", { finish_position: 3, rig_number: 5, laps_completed: 11 }),
      ],
      notInRace: [],
    });
    expect(html).toContain("Captured - check before closing");
    expect(html).toMatch(/P2<\/span><span[^>]*>Ben<\/span><span[^>]*>Rig 5 · iRacing P3 · 11 laps/);
    expect(html).toContain("Correct order");
  });

  it("flags a repeated place, a car not seen at the flag, a DNF and a driver with no finish", () => {
    const html = render({
      raceHeard: true,
      confirmed: false,
      entries: [
        entry("Ana", { finish_position: 2 }),
        entry("Ben", { finish_position: 2, laps_completed: 11 }),
        entry("Cal", { finish_position: 1, source: "close" }),
        entry("Dan", { finish_position: null, source: "staff" }),
      ],
      notInRace: [{ driver_id: "e", display_name: "Eve" }],
    });
    expect(html.match(/same place twice/g)).toHaveLength(2);
    expect(html).toContain("not seen at the flag");
    expect(html).toMatch(/DNF · <\/span>Dan/);
    expect(html).toMatch(/In the round, no race finish ·[^<]*<\/span>Eve/);
  });

  it("says when staff have confirmed the result", () => {
    const html = render({
      raceHeard: true,
      confirmed: true,
      entries: [entry("Ana", { source: "staff", rig_number: null, laps_completed: null })],
      notInRace: [],
    });
    expect(html).toContain("Confirmed by staff");
    expect(html).not.toContain("iRacing P");
  });
});
