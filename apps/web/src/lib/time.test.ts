import { describe, expect, it } from "vitest";
import { MAX_LAP_TIME_MS } from "./events";
import { formatLapTime, formatGap } from "./time";

describe("formatLapTime", () => {
  it("formats the canonical example", () => {
    expect(formatLapTime(138103)).toBe("2:18.103");
  });

  it("pads milliseconds and seconds", () => {
    expect(formatLapTime(60_001)).toBe("1:00.001");
    expect(formatLapTime(125_050)).toBe("2:05.050");
  });

  it("drops the minute part for sub-minute laps", () => {
    expect(formatLapTime(58_204)).toBe("58.204");
    expect(formatLapTime(9_500)).toBe("9.500");
  });

  it("prints the longest storable lap inside the width the /tv time columns are fitted for", () => {
    // arcade-board.tsx sizes both time columns through `59:59.999`. The
    // ingestion ceiling is chosen from what a lap can be, not from this - but
    // if it ever grows past what the column holds, this is where to find out.
    expect(formatLapTime(MAX_LAP_TIME_MS).length).toBeLessThanOrEqual(
      "59:59.999".length,
    );
  });

  it("handles nonsense defensively", () => {
    expect(formatLapTime(0)).toBe("—");
    expect(formatLapTime(-5)).toBe("—");
    expect(formatLapTime(Number.NaN)).toBe("—");
  });
});

describe("formatGap", () => {
  it("formats sub-minute gaps with three decimals", () => {
    expect(formatGap(621)).toBe("+0.621");
    expect(formatGap(12_004)).toBe("+12.004");
  });

  it("uses lap format for gaps over a minute", () => {
    expect(formatGap(61_204)).toBe("+1:01.204");
  });

  it("handles zero and negatives", () => {
    expect(formatGap(0)).toBe("—");
    expect(formatGap(-1)).toBe("");
  });
});
