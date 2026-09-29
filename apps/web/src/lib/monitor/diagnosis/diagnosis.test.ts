import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_GEMINI_MODEL,
  diagnose,
  diagnosisConfig,
  type DiagnosisConfig,
} from "./index";
import { incidentContext, pseudonym, type AlertForDiagnosis, type HeartbeatRow } from "./context";
import { handoffText } from "../handoff";
import anthropicAnswer from "./fixtures/anthropic-messages.json";
import geminiAnswer from "./fixtures/gemini-generate-content.json";
import geminiQuota from "./fixtures/gemini-quota-exceeded.json";

/**
 * The provider answers are fixtures in each API's documented response shape
 * (fixtures/), so no test here calls a model or needs a key.
 */

const DRIVER = "Matt Gonzalez";
const ASSIGNMENT = "0b5f8a52-7c1e-4d7a-9f3e-2a6c1b9d4e10";
const RIG = "7d1c0f3a-5b2e-4c8d-9a6f-1e2b3c4d5e6f";

const ALERT: AlertForDiagnosis = {
  id: "123",
  rule: "laps_stuck",
  severity: "urgent",
  openedAt: Date.parse("2026-10-04T21:14:00Z"),
  detail: {
    headline: `Rig 02: 4 laps waiting 6 min to reach the site while the rig is online`,
    where: "Rig 02",
    fields: [
      { name: "Driver", value: `${DRIVER} (seated 18 min)` },
      { name: "Last heard", value: "4 s ago" },
      { name: "Agent", value: "rig-agent/0.4-monitor" },
      { name: "Queued laps", value: "4" },
    ],
    driver: DRIVER,
  },
};

function heartbeat(agoS: number, pending: number, extra: Record<string, unknown> = {}): HeartbeatRow {
  return {
    receivedAt: Date.parse("2026-10-04T21:14:00Z") - agoS * 1000,
    clockSkewMs: 400,
    payload: {
      agentVersion: "rig-agent/0.4-monitor",
      telemetryMode: "iracing",
      simConnected: true,
      pendingLaps: pending,
      oldestPendingAgeS: 360 - agoS,
      rejectedLaps: 0,
      assignmentId: ASSIGNMENT,
      session: { trackName: "Circuit of the Americas", trackConfig: "Grand Prix", carName: "FIA F4" },
      ...extra,
    },
  };
}

/** Newest first, as the store reads them. */
const HEARTBEATS: HeartbeatRow[] = [
  heartbeat(0, 4, { notices: [`[agent] tick failed: lap for ${ASSIGNMENT} (${DRIVER}) was refused`] }),
  heartbeat(60, 3),
  heartbeat(120, 2, { notices: ["[agent] tick failed: HTTP 500"] }),
];

const GEMINI: DiagnosisConfig = { provider: "gemini", model: DEFAULT_GEMINI_MODEL, apiKey: "test-gemini-key" };
const ANTHROPIC: DiagnosisConfig = {
  provider: "anthropic",
  model: DEFAULT_ANTHROPIC_MODEL,
  apiKey: "test-anthropic-key",
};

function answering(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

describe("redaction before the call (D9)", () => {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  it.each([
    ["gemini", GEMINI, geminiAnswer],
    ["anthropic", ANTHROPIC, anthropicAnswer],
  ] as const)("sends %s no driver name and no id", async (_name, config, answer) => {
    const fetch = answering(answer);
    const context = incidentContext({ ...ALERT, id: "123" }, HEARTBEATS, "9b4fd5d1234567");
    await diagnose(context, config, { fetch });

    const body = fetch.mock.calls[0]![1]!.body as string;
    expect(body).not.toMatch(/matt|gonzalez/i);
    expect(body).not.toMatch(UUID);
    expect(body).not.toContain(RIG);
    expect(body).toContain(pseudonym(DRIVER));
    // What the model does get: the rule, the rig and its heartbeats.
    expect(body).toContain("Laps queued but not reaching the site");
    expect(body).toContain("Rig 02");
    expect(body).toContain("pendingLaps");
    expect(body).toContain('\\"driverSeated\\": true');
  });

  it("gives the same driver the same stand-in, and nothing of the name", () => {
    expect(pseudonym(DRIVER)).toMatch(/^driver-[0-9a-f]{4}$/);
    expect(pseudonym(DRIVER)).toBe(pseudonym(DRIVER));
    expect(pseudonym(DRIVER)).not.toBe(pseudonym("Ana B"));
  });

  it("replaces the name only as a whole word", () => {
    const context = incidentContext(
      {
        ...ALERT,
        detail: { ...ALERT.detail, headline: "Al is seated; Always check Al.", driver: "Al" },
      },
      [],
      null,
    );
    expect(context.headline).toBe(`${pseudonym("Al")} is seated; Always check ${pseudonym("Al")}.`);
  });

  it("keeps the handoff free of names and ids too", () => {
    const context = incidentContext(ALERT, HEARTBEATS, null);
    const text = handoffText(context, { ok: false, error: "timed out" });
    expect(text).not.toMatch(/matt|gonzalez/i);
    expect(text).not.toMatch(UUID);
  });
});

describe("provider switch", () => {
  it("defaults to Gemini Flash with only a Gemini key", () => {
    expect(diagnosisConfig({ GEMINI_API_KEY: " k " })).toEqual({
      provider: "gemini",
      model: "gemini-2.5-flash",
      apiKey: "k",
    });
  });

  it("switches to Claude Haiku with DIAGNOSIS_PROVIDER=anthropic", () => {
    expect(diagnosisConfig({ DIAGNOSIS_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g" })).toEqual(
      { provider: "anthropic", model: "claude-haiku-4-5-20251001", apiKey: "a" },
    );
  });

  it("takes the model from DIAGNOSIS_MODEL", () => {
    expect(diagnosisConfig({ GEMINI_API_KEY: "k", DIAGNOSIS_MODEL: "gemini-3-flash" })?.model).toBe("gemini-3-flash");
  });

  it("is off when told so, when the provider's key is missing, or for an unknown provider", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(diagnosisConfig({ DIAGNOSIS_PROVIDER: "off", GEMINI_API_KEY: "k" })).toBeNull();
    expect(diagnosisConfig({})).toBeNull();
    expect(diagnosisConfig({ DIAGNOSIS_PROVIDER: "anthropic", GEMINI_API_KEY: "k" })).toBeNull();
    expect(diagnosisConfig({ DIAGNOSIS_PROVIDER: "ollama", GEMINI_API_KEY: "k" })).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("calls Gemini's generateContent with the key in a header, not the URL", async () => {
    const fetch = answering(geminiAnswer);
    const result = await diagnose(incidentContext(ALERT, HEARTBEATS, null), GEMINI, { fetch });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect((init!.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-gemini-key");
    const body = JSON.parse(init!.body as string);
    expect(body.generationConfig).toMatchObject({
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: { type: "OBJECT", properties: { causeClass: { type: "STRING" } } },
    });
    expect(result).toMatchObject({ ok: true, diagnosis: { causeClass: "software", confidence: "medium" } });
  });

  it("calls Anthropic's Messages API and reads the forced tool call", async () => {
    const fetch = answering(anthropicAnswer);
    const result = await diagnose(incidentContext(ALERT, HEARTBEATS, null), ANTHROPIC, { fetch });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init!.headers as Record<string, string>)["x-api-key"]).toBe("test-anthropic-key");
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      temperature: 0.2,
      tool_choice: { type: "tool", name: "report_diagnosis" },
    });
    expect(result).toMatchObject({ ok: true, diagnosis: { causeClass: "software", confidence: "medium" } });
  });

  it("answers the same diagnosis from either provider", async () => {
    const context = incidentContext(ALERT, HEARTBEATS, null);
    const gemini = await diagnose(context, GEMINI, { fetch: answering(geminiAnswer) });
    const anthropic = await diagnose(context, ANTHROPIC, { fetch: answering(anthropicAnswer) });
    expect(gemini).toEqual(anthropic);
  });
});

describe("failures", () => {
  const context = incidentContext(ALERT, HEARTBEATS, null);

  it("gives up at the timeout", async () => {
    const hang = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
        }),
    );
    await expect(diagnose(context, GEMINI, { fetch: hang, timeoutMs: 20 })).resolves.toEqual({
      ok: false,
      error: "timed out",
    });
  });

  it("names a quota refusal by its status and keeps none of the provider's message", async () => {
    const result = await diagnose(context, GEMINI, { fetch: answering(geminiQuota, 429) });
    expect(result).toEqual({ ok: false, error: "HTTP 429 RESOURCE_EXHAUSTED" });
  });

  it("refuses an answer that is not a diagnosis", async () => {
    const wrong = { candidates: [{ content: { parts: [{ text: '{"summary":"x"}' }] } }] };
    await expect(diagnose(context, GEMINI, { fetch: answering(wrong) })).resolves.toEqual({
      ok: false,
      error: "the answer did not match the diagnosis shape",
    });
    const prose = { candidates: [{ content: { parts: [{ text: "I think the rig is off." }] } }] };
    await expect(diagnose(context, GEMINI, { fetch: answering(prose) })).resolves.toEqual({
      ok: false,
      error: "the answer was not JSON",
    });
  });

  it("reports an unreachable provider without quoting the request", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(diagnose(context, ANTHROPIC, { fetch: down })).resolves.toEqual({
      ok: false,
      error: "unreachable (TypeError)",
    });
  });
});
