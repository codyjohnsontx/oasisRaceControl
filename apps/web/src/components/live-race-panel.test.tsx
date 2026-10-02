import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SESSION_STATE } from "@/lib/events";
import { liveRaceFeed, liveRaceRow } from "@/test/live-race-fixture";
import { LiveRacePanel, LiveRaceTable } from "./live-race-panel";

/**
 * The phone's live race panel says the same things about each car as the
 * wall's race screen (`tv/race-board.test.tsx`), in a phone's layout.
 */

const render = (
  race = liveRaceFeed([liveRaceRow(1, 1), liveRaceRow(2, 2), liveRaceRow(3, 3)]),
  extra: Partial<Parameters<typeof LiveRaceTable>[0]["live"]> = {},
) =>
  renderToStaticMarkup(
    <LiveRaceTable live={{ race, finished: false, moves: new Map(), stale: false, ...extra }} />,
  );

const rowsIn = (html: string) => html.match(/<li[^>]*data-live-race-row[^>]*>[\s\S]*?<\/li>/g) ?? [];

describe("LiveRacePanel", () => {
  it("renders nothing until the feed has answered", () => {
    expect(renderToStaticMarkup(<LiveRacePanel />)).toBe("");
  });

  it("renders nothing while no race is on", () => {
    expect(render({ session: null, rows: [], otherRigs: 0 })).toBe("");
  });

  it("lists the field in place order with laps, last lap, gap and interval", () => {
    const race = liveRaceFeed([
      liveRaceRow(4, 1, { lapsCompleted: 12, lastLapMs: 95_123 }),
      liveRaceRow(1, 2, { lapsCompleted: 12, gapToLeaderS: 3.456, intervalS: 3.456 }),
    ]);
    const [leader, second] = rowsIn(render(race));
    expect(leader).toContain("Driver 4");
    expect(leader).toContain("L12");
    expect(leader).toContain("last 1:35.123");
    expect(leader).toContain("Leader");
    expect(second).toContain("+3.456");
    expect(second).toContain("int +3.456");
  });

  it("names an empty seat by its rig, dims a silent rig and marks a pit stop", () => {
    const race = liveRaceFeed([
      liveRaceRow(1, 1, { onPitRoad: true }),
      liveRaceRow(7, 2, { driverId: null, driverName: null }),
      liveRaceRow(3, 3, { stale: true, ageS: 30 }),
    ]);
    const [pitting, empty, silent] = rowsIn(render(race));
    expect(pitting).toContain("data-live-race-pit");
    expect(empty).toMatch(/text-muted[^>]*>Rig 7/);
    expect(silent).toContain("data-stale");
    expect(silent).toContain("no signal");
  });

  it("flashes a row that changed place and says how far", () => {
    const moves = new Map([
      [2, { delta: 1, seq: 1 }],
      [3, { delta: -1, seq: 2 }],
    ]);
    const [, up, down] = rowsIn(render(undefined, { moves }));
    expect(up).toContain("race-row-up");
    expect(up).toContain("▲1");
    expect(down).toContain("race-row-down");
    expect(down).toContain("▼1");
  });

  it("heads the panel with the session's state and what is left, then the result", () => {
    const racing = render(undefined);
    expect(racing).toContain("Live race");
    expect(racing).toContain("Racing · 10:00 to go · 3 cars");

    const finished = liveRaceFeed([liveRaceRow(1, 1), liveRaceRow(2, 2)], {
      sessionState: SESSION_STATE.checkered,
    });
    const result = render(finished, { finished: true });
    expect(result).toContain("Race result");
    expect(result).toContain("Chequered flag · 2 cars");
    expect(rowsIn(result)[0]).toContain("winner");
  });
});
