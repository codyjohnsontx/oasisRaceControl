import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SESSION_STATE } from "@/lib/events";
import { liveRaceFeed, liveRaceRow } from "@/test/live-race-fixture";
import { RaceOrder, SPLIT_AFTER } from "./race-board";

/**
 * What the wall's race screen says about each car, pinned on the markup: the
 * owner's rules for an empty seat, a silent rig, a pit stop and a pass.
 */

const render = (
  race = liveRaceFeed([liveRaceRow(1, 1), liveRaceRow(2, 2), liveRaceRow(3, 3)]),
  extra: Partial<Parameters<typeof RaceOrder>[0]> = {},
) =>
  renderToStaticMarkup(
    <RaceOrder
      eyebrow="Race"
      title="Wednesday Night League"
      race={race}
      finished={false}
      moves={new Map()}
      {...extra}
    />,
  );

const rowsIn = (html: string) => html.match(/<li[^>]*data-tv-race-row[^>]*>[\s\S]*?<\/li>/g) ?? [];

describe("RaceOrder", () => {
  it("numbers the rows by the feed's place, in the feed's order", () => {
    const race = liveRaceFeed([liveRaceRow(5, 1), liveRaceRow(2, 2), liveRaceRow(9, 3)]);
    const rows = rowsIn(render(race));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("01");
    expect(rows[0]).toContain("Driver 5");
    expect(rows[2]).toContain("03");
    expect(rows[2]).toContain("Driver 9");
  });

  it("names a rig nobody is signed in on by its number, in the muted colour", () => {
    const race = liveRaceFeed([
      liveRaceRow(1, 1),
      liveRaceRow(7, 2, { driverId: null, driverName: null }),
    ]);
    const [, empty] = rowsIn(render(race));
    expect(empty).toContain("Rig 7");
    expect(empty).toMatch(/text-muted[^>]*>Rig 7/);
  });

  it("dims a rig that stopped reporting where it was", () => {
    const race = liveRaceFeed([liveRaceRow(1, 1), liveRaceRow(2, 2, { stale: true, ageS: 20 })]);
    const [live, silent] = rowsIn(render(race));
    expect(silent).toContain("data-stale");
    expect(silent).toContain("opacity-40");
    expect(live).not.toContain("data-stale");
  });

  it("marks a car on pit road and nothing else", () => {
    const race = liveRaceFeed([liveRaceRow(1, 1), liveRaceRow(2, 2, { onPitRoad: true })]);
    const [leader, pitting] = rowsIn(render(race));
    expect(pitting).toContain("data-tv-race-pit");
    expect(pitting).toContain("PIT");
    expect(leader).not.toContain("data-tv-race-pit");
  });

  it("prints laps, gap to the leader, interval and last lap, and no gap for the leader", () => {
    const race = liveRaceFeed([
      liveRaceRow(1, 1, { lapsCompleted: 12, lastLapMs: 95_123 }),
      liveRaceRow(2, 2, { lapsCompleted: 12, gapToLeaderS: 3.456, intervalS: 3.456, lastLapMs: null }),
      liveRaceRow(3, 3, { lapsCompleted: 11, gapToLeaderS: 65.2, intervalS: 61.744 }),
    ]);
    const [leader, second, third] = rowsIn(render(race));
    expect(leader).toContain("Leader");
    expect(leader).toContain("1:35.123");
    expect(second).toContain("+3.456");
    expect(third).toContain("+1:05.200");
    expect(third).toContain("+1:01.744");
    expect(third).toContain(">11<");
  });

  it("flashes a row that moved and says how far, up in green and down in red", () => {
    const moves = new Map([
      [2, { delta: 2, seq: 1 }],
      [3, { delta: -1, seq: 2 }],
    ]);
    const [leader, up, down] = rowsIn(render(undefined, { moves }));
    expect(leader).not.toContain("race-row-moved");
    expect(up).toContain("race-row-up");
    expect(up).toContain('data-moved="up"');
    expect(up).toContain("▲2");
    expect(down).toContain("race-row-down");
    expect(down).toContain("▼1");
  });

  it("names the winner once the flag is out", () => {
    expect(render()).not.toContain("Winner");
    const finished = liveRaceFeed([liveRaceRow(1, 1), liveRaceRow(2, 2)], {
      sessionState: SESSION_STATE.checkered,
    });
    const [winner, second] = rowsIn(render(finished, { finished: true }));
    expect(winner).toContain("Winner");
    expect(second).not.toContain("Winner");
  });

  it("draws a league field as two halves, and a small one as one list", () => {
    const small = render();
    expect(small.match(/>Pos</g)).toHaveLength(1);

    const field = Array.from({ length: SPLIT_AFTER + 1 }, (_, i) => liveRaceRow(i + 1, i + 1));
    const big = render(liveRaceFeed(field));
    expect(big.match(/>Pos</g)).toHaveLength(2);
    expect(rowsIn(big)).toHaveLength(SPLIT_AFTER + 1);
    // Both halves are the same composition at three quarters of the size.
    expect(big).toContain("text-[0.75em]");
    expect(small).not.toContain("text-[0.75em]");
  });

  it("says what is on screen in the header and dims when held", () => {
    const html = render(undefined, { subtitle: "Spa-Francorchamps", stale: true });
    expect(html).toContain(">Race<");
    expect(html).toContain("Spa-Francorchamps");
    expect(html).toContain("opacity-70");
  });
});
