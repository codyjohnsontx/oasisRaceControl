import { z } from "zod";
import { askAnthropic } from "./anthropic";
import type { IncidentContext } from "./context";
import { askGemini } from "./gemini";
import {
  CAUSE_CLASSES,
  CONFIDENCES,
  ProviderError,
  type DiagnosisConfig,
} from "./provider";

export { DIAGNOSIS_JSON_SCHEMA, TEMPERATURE, type DiagnosisConfig } from "./provider";

/**
 * The AI diagnosis an urgent alert gets (owner decisions R4 and R6): a model
 * reads the redacted incident (context.ts) and says what probably went wrong
 * and what to change. Gemini Flash on the free tier by default; Claude Haiku
 * is one environment variable away. Only ever a second opinion: the alert has
 * already been posted when this runs, and a diagnosis that fails or times out
 * delays nothing (run.ts).
 *
 *   DIAGNOSIS_PROVIDER  gemini (default) | anthropic | off
 *   DIAGNOSIS_MODEL     defaults to the provider's model below
 *   GEMINI_API_KEY / ANTHROPIC_API_KEY
 *
 * Keys come only from the environment. A provider without its key is off, so
 * a preview or a laptop never calls one.
 */

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

/** Well inside Vercel's function limit, and far past a normal answer. */
export const DIAGNOSIS_TIMEOUT_MS = 20_000;

export function diagnosisConfig(env: Record<string, string | undefined> = process.env): DiagnosisConfig | null {
  const provider = (env.DIAGNOSIS_PROVIDER?.trim().toLowerCase() || "gemini") as string;
  if (provider !== "gemini" && provider !== "anthropic") {
    if (provider !== "off") console.error(`[monitor] unknown DIAGNOSIS_PROVIDER "${provider}"; diagnosis is off`);
    return null;
  }
  const apiKey = (provider === "gemini" ? env.GEMINI_API_KEY : env.ANTHROPIC_API_KEY)?.trim();
  if (!apiKey) return null;
  const model =
    env.DIAGNOSIS_MODEL?.trim() || (provider === "gemini" ? DEFAULT_GEMINI_MODEL : DEFAULT_ANTHROPIC_MODEL);
  return { provider, model, apiKey };
}

/** What the model must answer, checked here rather than trusted. */
export const diagnosisSchema = z.object({
  summary: z.string().trim().min(1).max(1500),
  likelyCause: z.string().trim().min(1).max(1000),
  causeClass: z.enum(CAUSE_CLASSES),
  suggestedChange: z.string().trim().min(1).max(1500),
  whereToLook: z.array(z.string().trim().min(1).max(200)).max(6),
  confidence: z.enum(CONFIDENCES),
});

export type Diagnosis = z.infer<typeof diagnosisSchema>;

export const SYSTEM_PROMPT = `You diagnose alerts from the rig monitor of Oasis Race Control, a sim-racing venue's lap-timing platform.

How it works: each sim rig runs iRacing and a small Windows agent (.NET, apps/rig-agent) that reads laps from iRacing's shared memory, queues them in a local SQLite outbox and posts them to a Next.js site on Vercel (apps/web) backed by Neon Postgres. The agent sends a heartbeat every 60 s describing itself; a server-side monitor judges those heartbeats with fixed rules and has raised the alert below. A lap refused by the site is parked on the rig and never re-sent. A driver signs in to a rig; laps are attributed to whoever was seated when the lap was captured.

You have no access to the code. Reason only from the alert and the heartbeats. Driver names and ids are redacted on purpose. Be specific and brief; say "unknown" rather than guess. causeClass is "software" only when a code defect is a plausible cause; an unplugged rig, a closed iRacing or a staff step is "operational", a venue network problem is "network".

Repository paths you may cite in whereToLook:
apps/web/src/app/api/agent/events/route.ts (lap and heartbeat ingestion)
apps/web/src/lib/events.ts (the wire contract and its bounds)
apps/web/src/lib/monitor/rules.ts (the alert rules)
apps/rig-agent/OasisRigAgent.Core/AgentService.cs (agent loop, outbox flush, sign-out)
apps/rig-agent/OasisRigAgent.Core/BackendClient.cs (HTTP to the site)
apps/rig-agent/OasisRigAgent.Core/EventQueue.cs (the outbox)
apps/rig-agent/OasisRigAgent.Core/Heartbeat.cs (heartbeat report and backoff)
apps/rig-agent/OasisRigAgent.Core/Iracing/IracingTelemetrySource.cs (reading iRacing)
apps/rig-agent/OasisRigAgent.Core/Iracing/LapDetector.cs (lap detection)
apps/rig-agent/OasisRigAgent.Core/DriverCheckInClient.cs (walk-up sign-in)

Answer with the JSON object only.`;

/** The user turn: the redacted incident, as JSON. */
export function userPrompt(context: IncidentContext): string {
  return `Alert:\n${JSON.stringify(context, null, 2)}`;
}

export type DiagnosisResult =
  | { ok: true; diagnosis: Diagnosis }
  | { ok: false; error: string };

/**
 * One call to the configured provider. Resolves - never throws - with a
 * checked diagnosis or an error safe to store and log: a provider's error
 * body is never kept, since it can quote the request.
 */
export async function diagnose(
  context: IncidentContext,
  config: DiagnosisConfig,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<DiagnosisResult> {
  const ask = config.provider === "gemini" ? askGemini : askAnthropic;
  try {
    const raw = await ask(config, SYSTEM_PROMPT, userPrompt(context), {
      fetch: options.fetch ?? fetch,
      signal: AbortSignal.timeout(options.timeoutMs ?? DIAGNOSIS_TIMEOUT_MS),
    });
    const parsed = diagnosisSchema.safeParse(raw);
    return parsed.success
      ? { ok: true, diagnosis: parsed.data }
      : { ok: false, error: "the answer did not match the diagnosis shape" };
  } catch (error) {
    if (error instanceof ProviderError) return { ok: false, error: error.message };
    const name = error instanceof Error ? error.name : "Error";
    return { ok: false, error: name === "TimeoutError" ? "timed out" : `unreachable (${name})` };
  }
}
