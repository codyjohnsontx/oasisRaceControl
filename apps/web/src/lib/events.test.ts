import { describe, expect, it } from "vitest";
import { MAX_LAP_TIME_MS, agentEventsBody } from "./events";

const lap = {
  type: "LAP_COMPLETED",
  eventId: "fake-rig-1-000123",
  trackName: "Spa-Francorchamps",
  trackConfig: "Grand Prix Pits",
  carName: "Porsche 911 GT3 R",
  lapNumber: 8,
  lapTimeMs: 138103,
  incidentDelta: 0,
  completedAt: "2026-07-11T20:15:00.000Z",
};

describe("agent events contract", () => {
  it("accepts a heartbeat and a lap", () => {
    const result = agentEventsBody.safeParse({
      events: [{ type: "RIG_HEARTBEAT", agentVersion: "fake-rig/0.1" }, lap],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a lap without an idempotency key", () => {
    const rest: Record<string, unknown> = { ...lap };
    delete rest.eventId;
    expect(agentEventsBody.safeParse({ events: [rest] }).success).toBe(false);
  });

  it("rejects non-positive lap times", () => {
    expect(
      agentEventsBody.safeParse({ events: [{ ...lap, lapTimeMs: 0 }] }).success,
    ).toBe(false);
  });

  it("rejects a lap time longer than any lap the venue can produce", () => {
    // 7,425,678 ms - two hours and change - is the value that rendered as
    // `123:45.678` on the wall and spilled out of its column.
    expect(
      agentEventsBody.safeParse({ events: [{ ...lap, lapTimeMs: 7_425_678 }] })
        .success,
    ).toBe(false);
  });

  it("accepts a lap time at the ceiling and rejects one millisecond over it", () => {
    expect(
      agentEventsBody.safeParse({
        events: [{ ...lap, lapTimeMs: MAX_LAP_TIME_MS }],
      }).success,
    ).toBe(true);
    expect(
      agentEventsBody.safeParse({
        events: [{ ...lap, lapTimeMs: MAX_LAP_TIME_MS + 1 }],
      }).success,
    ).toBe(false);
  });

  it("rejects unknown event types", () => {
    expect(
      agentEventsBody.safeParse({ events: [{ type: "MYSTERY" }] }).success,
    ).toBe(false);
  });

  it("rejects an empty batch", () => {
    expect(agentEventsBody.safeParse({ events: [] }).success).toBe(false);
  });

  it("accepts offset timestamps", () => {
    expect(
      agentEventsBody.safeParse({
        events: [{ ...lap, completedAt: "2026-07-11T15:15:00.000-05:00" }],
      }).success,
    ).toBe(true);
  });
});
