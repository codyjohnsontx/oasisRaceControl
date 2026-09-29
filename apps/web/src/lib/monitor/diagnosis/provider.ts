export type ProviderName = "gemini" | "anthropic";
export type DiagnosisConfig = { provider: ProviderName; model: string; apiKey: string };

/** Low: a diagnosis should read the evidence the same way twice. */
export const TEMPERATURE = 0.2;

export const CAUSE_CLASSES = ["operational", "network", "software", "unknown"] as const;
export const CONFIDENCES = ["low", "medium", "high"] as const;

/** The answer's shape as JSON Schema, for providers that constrain output to one. */
export const DIAGNOSIS_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "Two or three sentences for venue staff: what is wrong." },
    likelyCause: { type: "string", description: "The most likely cause, specific to the evidence." },
    causeClass: { type: "string", enum: [...CAUSE_CLASSES] },
    suggestedChange: {
      type: "string",
      description: "What to do: an operational step, or the code change a developer should make.",
    },
    whereToLook: {
      type: "array",
      items: { type: "string" },
      description: "Repository paths from the list given, most relevant first.",
    },
    confidence: { type: "string", enum: [...CONFIDENCES] },
  },
  required: ["summary", "likelyCause", "causeClass", "suggestedChange", "whereToLook", "confidence"],
} as const;

/** What a provider module gets besides the prompt. */
export type AskOptions = { fetch: typeof fetch; signal: AbortSignal };

/** A provider answered, but not with a diagnosis. The message is safe to store. */
export class ProviderError extends Error {}

/** Parses a JSON answer, allowing the markdown fence some models add anyway. */
export function parseJsonAnswer(text: string): unknown {
  const bare = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(bare);
  } catch {
    throw new ProviderError("the answer was not JSON");
  }
}
