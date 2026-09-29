import { describe, expect, it } from "vitest";
import { incidentContext, type HeartbeatRow } from "./diagnosis/context";
import type { Diagnosis } from "./diagnosis";
import { diagnosisMessage, handoffMessage, handoffText } from "./handoff";
import { DISCORD_LIMITS } from "./discord";

const OPENED = Date.parse("2026-10-04T21:14:00Z");

function heartbeat(agoS: number, pending: number): HeartbeatRow {
  return {
    receivedAt: OPENED - agoS * 1000,
    clockSkewMs: 400,
    payload: {
      agentVersion: "rig-agent/0.4-monitor",
      simConnected: true,
      pendingLaps: pending,
      oldestPendingAgeS: 360 - agoS,
      notices: agoS === 0 ? ["[agent] tick failed: HTTP 500 server_error"] : [],
    },
  };
}

const CONTEXT = incidentContext(
  {
    id: "123",
    rule: "laps_stuck",
    severity: "urgent",
    openedAt: OPENED,
    detail: {
      headline: "Rig 02: 4 laps waiting 6 min to reach the site while the rig is online",
      where: "Rig 02",
      fields: [],
    },
  },
  [heartbeat(0, 4), heartbeat(60, 3), heartbeat(120, 2), heartbeat(180, 1)],
  "9b4fd5d0c0ffee",
);

const DIAGNOSIS: Diagnosis = {
  summary: "Rig 02 is online but the site is not storing its laps.",
  likelyCause: "The events route answers the lap batch with a 500.",
  causeClass: "software",
  suggestedChange: "Reproduce with fake-rig and fix the failing insert in the events route.",
  whereToLook: ["apps/web/src/app/api/agent/events/route.ts"],
  confidence: "medium",
};

describe("handoffText", () => {
  it("is the fixed frame, byte for byte", () => {
    expect(handoffText(CONTEXT, { ok: true, diagnosis: DIAGNOSIS })).toMatchInlineSnapshot(`
      "Oasis rig alert #123 - rule 3a: Laps queued but not reaching the site (Rig 02)
      Opened 2026-10-04 21:14 UTC (4:14 PM venue) · agent rig-agent/0.4-monitor
      Site commit: 9b4fd5d · repo codyjohnsontx/oasisRaceControl
      What the monitor saw: Rig 02: 4 laps waiting 6 min to reach the site while the rig is online
      Rig state (last 3 heartbeats): 21:12:00, sim connected, pending 2 (oldest 240 s), skew +0.4 s; 21:13:00, sim connected, pending 3 (oldest 300 s), skew +0.4 s; 21:14:00, sim connected, pending 4 (oldest 360 s), skew +0.4 s
      Recent agent notices: [agent] tick failed: HTTP 500 server_error
      Likely cause (AI, confidence medium): The events route answers the lap batch with a 500.
      Suggested change: Reproduce with fake-rig and fix the failing insert in the events route.
      Where to look: apps/web/src/app/api/agent/events/route.ts
      Rules: reproduce end-to-end first (CLAUDE.md); fix on a branch and open a PR; do not touch the hosted database; the owner approves every merge."
    `);
  });

  it("still frames the incident when the model gave no diagnosis", () => {
    expect(handoffText(CONTEXT, { ok: false, error: "timed out" })).toMatchInlineSnapshot(`
      "Oasis rig alert #123 - rule 3a: Laps queued but not reaching the site (Rig 02)
      Opened 2026-10-04 21:14 UTC (4:14 PM venue) · agent rig-agent/0.4-monitor
      Site commit: 9b4fd5d · repo codyjohnsontx/oasisRaceControl
      What the monitor saw: Rig 02: 4 laps waiting 6 min to reach the site while the rig is online
      Rig state (last 3 heartbeats): 21:12:00, sim connected, pending 2 (oldest 240 s), skew +0.4 s; 21:13:00, sim connected, pending 3 (oldest 300 s), skew +0.4 s; 21:14:00, sim connected, pending 4 (oldest 360 s), skew +0.4 s
      Recent agent notices: [agent] tick failed: HTTP 500 server_error
      Likely cause (AI): no diagnosis (timed out)
      Rules: reproduce end-to-end first (CLAUDE.md); fix on a branch and open a PR; do not touch the hosted database; the owner approves every merge."
    `);
  });

  it("fits one Discord message however long the parts are, and keeps its fence whole", () => {
    const long = "x".repeat(5000);
    const context = { ...CONTEXT, headline: long, notices: Array(10).fill(`\`\`\`${long}`) };
    const diagnosis = { ...DIAGNOSIS, likelyCause: long, suggestedChange: long, whereToLook: [long] };
    const message = handoffMessage(handoffText(context, { ok: true, diagnosis }));

    expect(message.content!.length).toBeLessThanOrEqual(DISCORD_LIMITS.content);
    expect(message.content!.match(/```/g)).toHaveLength(2);
    expect(message.allowed_mentions).toEqual({ parse: [] });
  });
});

describe("diagnosisMessage", () => {
  it("is a purple embed naming the provider and confidence, pinging no one", () => {
    expect(diagnosisMessage({ id: "123", rule: "laps_stuck" }, DIAGNOSIS, "gemini")).toEqual({
      embeds: [
        {
          title: "Likely cause (Gemini, confidence medium)",
          description:
            "Rig 02 is online but the site is not storing its laps.\n\n" +
            "**Suggested change:** Reproduce with fake-rig and fix the failing insert in the events route.",
          color: 0x9b59b6,
          footer: { text: "alert #123 · rule 3a" },
        },
      ],
      allowed_mentions: { parse: [] },
    });
  });

  it("stays inside the embed limit", () => {
    const long = { ...DIAGNOSIS, summary: "y".repeat(3000), suggestedChange: "z".repeat(3000) };
    const embed = diagnosisMessage({ id: "1", rule: "laps_stuck" }, long, "anthropic").embeds![0]!;
    expect(embed.description!.length).toBeLessThanOrEqual(DISCORD_LIMITS.embedDescription);
    expect(embed.title).toBe("Likely cause (Claude, confidence medium)");
  });
});
