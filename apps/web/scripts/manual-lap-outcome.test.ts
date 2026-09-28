import { describe, expect, it } from "vitest";
import { manualLapOutcome } from "./manual-lap-outcome";

const answer = (status: string) => ({ results: [{ type: "LAP_COMPLETED", eventId: "manual-1", status }] });

describe("manualLapOutcome", () => {
  it("reports success only for a lap stored for the driver", () => {
    expect(manualLapOutcome(answer("accepted"), "Mike")).toEqual({
      ok: true,
      message: "stored for Mike and ranking",
    });
  });

  it("fails a lap stored unclaimed, pointing at this machine's clock", () => {
    // completedAt fell outside the stint's window plus its clock-skew grace:
    // HTTP 200, lap stored, credited to nobody. Re-checking the driver in would
    // not change that; a wrong clock on this machine is what does it.
    const outcome = manualLapOutcome(answer("accepted_unattributed"), "Mike");
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/NOT credited to Mike/);
    expect(outcome.message).toMatch(/unclaimed/);
    expect(outcome.message).toMatch(/clock/);
    expect(outcome.message).not.toMatch(/check the driver in again/i);
  });

  it.each(["accepted_invalid", "duplicate", "error"])("fails a %s result", (status) => {
    expect(manualLapOutcome(answer(status), "Mike").ok).toBe(false);
  });

  it.each([null, {}, { results: [] }, { results: "x" }])("fails an answer with no single result: %j", (body) => {
    expect(manualLapOutcome(body, "Mike").ok).toBe(false);
  });
});
