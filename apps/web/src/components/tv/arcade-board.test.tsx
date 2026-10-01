import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ArcadeHighScores, SLOT_COUNT, type ArcadeEntry } from "./arcade-board";

/**
 * The two layouts of the one table, pinned on the markup they render: the
 * rotation's ten slots, filled or open, against the event view's every-row
 * list. What the scroll layout does once it is measured against a screen is a
 * browser behaviour (`auto-scroll.tsx`), proven by hand on the event's laptop
 * size; here the server render only shows the rows exist to be scrolled.
 */

const entries = (n: number): ArcadeEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `driver-${i + 1}`,
    name: `Driver ${i + 1}`,
    detail: "FIA F4",
    timeMs: 130_000 + i * 700,
  }));

const rowsIn = (html: string) => (html.match(/<li /g) ?? []).length;
const asterisksIn = (html: string) => (html.match(/data-tv-asterisk/g) ?? []).length;
const openSlotsIn = (html: string) => (html.match(/· · · · ·/g) ?? []).length;

describe("ArcadeHighScores layouts", () => {
  it("slots: always ten rows, the unfilled ones open, however many entries", () => {
    const busy = renderToStaticMarkup(<ArcadeHighScores eyebrow="e" title="t" entries={entries(26)} />);
    expect(rowsIn(busy)).toBe(SLOT_COUNT);
    expect(openSlotsIn(busy)).toBe(0);
    expect(busy).not.toContain("Driver 11");

    const quiet = renderToStaticMarkup(<ArcadeHighScores eyebrow="e" title="t" entries={entries(3)} />);
    expect(rowsIn(quiet)).toBe(SLOT_COUNT);
    expect(openSlotsIn(quiet)).toBe(SLOT_COUNT - 3);
  });

  it("scroll: every entry is a row, none are open, and the last one is there", () => {
    const html = renderToStaticMarkup(
      <ArcadeHighScores eyebrow="e" title="t" entries={entries(26)} layout="scroll" />,
    );
    expect(rowsIn(html)).toBe(26);
    expect(openSlotsIn(html)).toBe(0);
    expect(html).toContain("Driver 26");
    // Before it is measured against a screen the list is drawn once, unmoving.
    expect(html).not.toContain("tv-auto-scroll\"");
    expect(html).toContain("data-tv-auto-scroll");
  });

  it("widens the rank track for three-digit ranks and keeps two-digit boards at 5em", () => {
    // The event view's list can run past a hundred drivers, where the old fixed
    // two-digit track printed "100" into the driver's name.
    const rankWidth = (html: string) => html.match(/--tv-rank-w:([^;"]+)/)?.[1];
    const hundred = renderToStaticMarkup(
      <ArcadeHighScores eyebrow="e" title="t" entries={entries(100)} layout="scroll" />,
    );
    expect(rankWidth(hundred)).toBe("7.5em");
    const slots = renderToStaticMarkup(<ArcadeHighScores eyebrow="e" title="t" entries={entries(26)} />);
    expect(rankWidth(slots)).toBe("5em");
    const shortList = renderToStaticMarkup(
      <ArcadeHighScores eyebrow="e" title="t" entries={entries(99)} layout="scroll" />,
    );
    expect(rankWidth(shortList)).toBe("5em");
  });

  it("an entry asking for an asterisk gets one after its score, and only that entry", () => {
    const [clean, marked, unset] = entries(3);
    const html = renderToStaticMarkup(
      <ArcadeHighScores
        eyebrow="e"
        title="t"
        entries={[clean, { ...marked, asterisk: true }, { ...unset, asterisk: false }]}
      />,
    );
    expect(asterisksIn(html)).toBe(1);
    // It follows the marked driver's time, not the clean one before it.
    expect(html.indexOf("data-tv-asterisk")).toBeGreaterThan(html.indexOf("Driver 2"));
    expect(html.indexOf("data-tv-asterisk")).toBeLessThan(html.indexOf("Driver 3"));
  });
});
