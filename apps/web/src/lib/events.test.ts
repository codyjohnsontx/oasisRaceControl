import { describe, expect, it } from "vitest";
import { agentEventsBody } from "./events";

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
    const { eventId: _dropped, ...rest } = lap;
    expect(agentEventsBody.safeParse({ events: [rest] }).success).toBe(false);
  });

  it("rejects non-positive lap times", () => {
    expect(
      agentEventsBody.safeParse({ events: [{ ...lap, lapTimeMs: 0 }] }).success,
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
