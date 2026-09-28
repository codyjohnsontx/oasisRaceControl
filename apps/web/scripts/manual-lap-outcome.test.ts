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

  it("fails a lap stored unclaimed, naming the attribution problem", () => {
    // The driver signed out between the assignment poll and the post: HTTP 200,
    // lap stored, credited to nobody.
    const outcome = manualLapOutcome(answer("accepted_unattributed"), "Mike");
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/NOT credited to Mike/);
    expect(outcome.message).toMatch(/unclaimed/);
  });

  it.each(["accepted_invalid", "duplicate", "error"])("fails a %s result", (status) => {
    expect(manualLapOutcome(answer(status), "Mike").ok).toBe(false);
  });

  it.each([null, {}, { results: [] }, { results: "x" }])("fails an answer with no single result: %j", (body) => {
    expect(manualLapOutcome(body, "Mike").ok).toBe(false);
  });
});
