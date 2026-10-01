import { parseJsonAnswer, ProviderError, type AskOptions, type DiagnosisConfig, DIAGNOSIS_JSON_SCHEMA, TEMPERATURE } from "./provider";

/**
 * Gemini's generateContent over REST, with the answer constrained to the
 * diagnosis schema. The key goes in the x-goog-api-key header, never the URL,
 * so no log line that quotes a URL can carry it.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export async function askGemini(
  config: DiagnosisConfig,
  system: string,
  user: string,
  options: AskOptions,
): Promise<unknown> {
  const response = await options.fetch(`${ENDPOINT}/${encodeURIComponent(config.model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": config.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        temperature: TEMPERATURE,
        responseMimeType: "application/json",
        responseSchema: geminiSchema(DIAGNOSIS_JSON_SCHEMA),
      },
    }),
    signal: options.signal,
  });
  const body = (await response.json().catch(() => null)) as GeminiResponse | null;
  if (!response.ok) {
    // Google's error status ("RESOURCE_EXHAUSTED") says what was wrong; its
    // message is not kept.
    const status = body?.error?.status;
    throw new ProviderError(`HTTP ${response.status}${status ? ` ${status}` : ""}`);
  }
  const candidate = body?.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .filter((part) => !part.thought && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  if (!text) throw new ProviderError(`no answer (${candidate?.finishReason ?? "no candidate"})`);
  return parseJsonAnswer(text);
}

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  error?: { status?: string };
};

/** Gemini's schema dialect is OpenAPI's, with the type names upper-cased. */
function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      key === "type" && typeof value === "string"
        ? value.toUpperCase()
        : key === "enum" || key === "required"
          ? value
          : geminiSchema(value),
    ]),
  );
}
