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
  it("accepts a lap that reports going off the road", () => {
    const result = agentEventsBody.safeParse({
      events: [{ ...lap, offTrackSeen: true }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a lap from an agent too old to report the surface", () => {
    // The outbox outlives an agent update, so laps queued by the previous
    // version drain through the new contract. A REQUIRED field here quarantines
    // every one of them on every rig at once (apps/rig-agent/README.md).
    for (const offTrackSeen of [undefined, null]) {
      expect(agentEventsBody.safeParse({ events: [{ ...lap, offTrackSeen }] }).success)
        .toBe(true);
    }
  });

  it("refuses an off-track claim that is not a yes or a no", () => {
    expect(
      agentEventsBody.safeParse({ events: [{ ...lap, offTrackSeen: "yes" }] }).success,
    ).toBe(false);
  });

  it("accepts a heartbeat and a lap", () => {
    const result = agentEventsBody.safeParse({
      events: [{ type: "RIG_HEARTBEAT", agentVersion: "fake-rig/0.1" }, lap],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a heartbeat that reports what the rig can do with its sim", () => {
    const result = agentEventsBody.safeParse({
      events: [
        {
          type: "RIG_HEARTBEAT",
          agentVersion: "oasis-rig-agent/0.4",
          simHealth: "unreadable",
          simHealthDetail: "the simulator does not publish OnPitRoad",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a heartbeat from an agent too old to report its sim", () => {
    // Rigs are updated one at a time, so a fleet mid-update sends both shapes.
    // An older agent losing its heartbeat would take it off the dashboard.
    expect(
      agentEventsBody.safeParse({
        events: [{ type: "RIG_HEARTBEAT", agentVersion: "oasis-rig-agent/0.3" }],
      }).success,
    ).toBe(true);
  });

  it("accepts a heartbeat that says which computer it came from", () => {
    expect(
      agentEventsBody.safeParse({
        events: [
          {
            type: "RIG_HEARTBEAT",
            agentVersion: "oasis-rig-agent/0.5",
            installationId: "aaaaaaaabbbbbbbbccccccccdddddddd",
            machineName: "RIG-03",
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("refuses a machine name that would not fit on the dashboard", () => {
    // A heartbeat refused outright takes the rig off the board entirely, so the
    // agent clips the name itself - this is the backstop that keeps the cap real.
    expect(
      agentEventsBody.safeParse({
        events: [{ type: "RIG_HEARTBEAT", machineName: "x".repeat(200) }],
      }).success,
    ).toBe(false);
  });

  it("refuses a blank machine name rather than storing one", () => {
    // "" on the dashboard beside a rig that is holding laps says nothing about
    // which computer to go and look at.
    expect(
      agentEventsBody.safeParse({
        events: [{ type: "RIG_HEARTBEAT", machineName: "" }],
      }).success,
    ).toBe(false);
  });

  it("rejects a sim health the dashboard has no answer for", () => {
    expect(
      agentEventsBody.safeParse({
        events: [{ type: "RIG_HEARTBEAT", simHealth: "probably_fine" }],
      }).success,
    ).toBe(false);
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

  it("rejects unknown event types", () => {
    expect(
      agentEventsBody.safeParse({ events: [{ type: "MYSTERY" }] }).success,
    ).toBe(false);
  });

  it("rejects an empty batch", () => {
    expect(agentEventsBody.safeParse({ events: [] }).success).toBe(false);
  });

  it("accepts a lap that names the assignment it was driven under", () => {
    expect(
      agentEventsBody.safeParse({
        events: [{ ...lap, rigAssignmentId: "6d1f7c2e-0b1a-4c3d-9e5f-0a1b2c3d4e5f" }],
      }).success,
    ).toBe(true);
  });

  it("accepts a lap that names no assignment", () => {
    // The agent sends null when it knew of no check-in; older agents and the
    // fake-rig simulator omit the field entirely.
    expect(
      agentEventsBody.safeParse({ events: [{ ...lap, rigAssignmentId: null }] }).success,
    ).toBe(true);
    expect(agentEventsBody.safeParse({ events: [lap] }).success).toBe(true);
  });

  it("rejects an assignment id that is not an id", () => {
    // Refusing it here keeps a malformed claim from reaching the attribution
    // query, where it would silently match nothing and look like a closed rig.
    expect(
      agentEventsBody.safeParse({ events: [{ ...lap, rigAssignmentId: "rig-7" }] }).success,
    ).toBe(false);
  });

  it("accepts offset timestamps", () => {
    expect(
      agentEventsBody.safeParse({
        events: [{ ...lap, completedAt: "2026-07-11T15:15:00.000-05:00" }],
      }).success,
    ).toBe(true);
  });
});
