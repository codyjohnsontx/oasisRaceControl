import { describe, expect, it } from "vitest";
import { alertMessage, recoveryMessage, type AlertForMessage } from "./messages";

const OPENED = Date.parse("2026-10-04T21:00:00Z");

const URGENT: AlertForMessage = {
  id: "123",
  rule: "rig_silent",
  severity: "urgent",
  openedAt: OPENED,
  resolvedAt: null,
  detail: {
    headline: "Rig 02 has been silent for 2 min with Matt G signed in",
    where: "Rig 02",
    fields: [
      { name: "Driver", value: "Matt G (seated 18 min)" },
      { name: "Last heard", value: "2 min ago" },
      { name: "Agent", value: "rig-agent/0.4-monitor" },
    ],
  },
};

const OWNER = "123456789012345678";

describe("alertMessage", () => {
  it("mentions the owner on an urgent alert, and allows exactly that mention", () => {
    const message = alertMessage(URGENT, OWNER);
    expect(message.content).toBe(`<@${OWNER}> 🔴 Rig 02 has been silent for 2 min with Matt G signed in`);
    expect(message.allowed_mentions).toEqual({ parse: [], users: [OWNER] });
    expect(message.embeds).toEqual([
      {
        title: "Rig silent",
        color: 0xe74c3c,
        fields: [
          { name: "Where", value: "Rig 02", inline: true },
          { name: "Driver", value: "Matt G (seated 18 min)", inline: true },
          { name: "Last heard", value: "2 min ago", inline: true },
          { name: "Agent", value: "rig-agent/0.4-monitor", inline: true },
        ],
        footer: { text: "alert #123 · rule 1" },
      },
    ]);
  });

  it("posts an urgent alert without a mention when no owner id is configured", () => {
    const message = alertMessage(URGENT, null);
    expect(message.content).toBe("🔴 Rig 02 has been silent for 2 min with Matt G signed in");
    expect(message.allowed_mentions).toEqual({ parse: [] });
  });

  it("keeps a warning quiet: yellow, and no mention even with an owner id", () => {
    const message = alertMessage({ ...URGENT, severity: "warning" }, OWNER);
    expect(message.content).toBe("🟡 Rig 02 has been silent for 2 min with Matt G signed in");
    expect(message.allowed_mentions).toEqual({ parse: [] });
    expect(message.embeds![0]!.color).toBe(0xf1c40f);
  });

  it("allows no mention a driver's name could carry", () => {
    const message = alertMessage(
      { ...URGENT, severity: "warning", detail: { ...URGENT.detail, headline: "@everyone <@1> hi" } },
      OWNER,
    );
    expect(message.allowed_mentions).toEqual({ parse: [] });
  });

  it("clips to Discord's limits instead of having the whole post refused", () => {
    const long = "x".repeat(5000);
    const message = alertMessage(
      { ...URGENT, detail: { headline: long, where: "Rig 02", fields: [{ name: "Notes", value: long }] } },
      OWNER,
    );
    expect(message.content!.length).toBe(2000);
    expect(message.content!.endsWith("...")).toBe(true);
    expect(message.embeds![0]!.fields![1]!.value.length).toBe(1024);
  });
});

describe("recoveryMessage", () => {
  it("is one quiet line saying what recovered and how long it was open", () => {
    const message = recoveryMessage({ ...URGENT, resolvedAt: OPENED + 6 * 60_000 });
    expect(message).toEqual({
      content: "🟢 Recovered: Rig silent - Rig 02 (alert #123, after 6 min)",
      allowed_mentions: { parse: [] },
    });
  });
});
