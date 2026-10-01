import { ProviderError, type AskOptions, type DiagnosisConfig, DIAGNOSIS_JSON_SCHEMA, TEMPERATURE } from "./provider";

/**
 * The Anthropic Messages API, for DIAGNOSIS_PROVIDER=anthropic. The answer is
 * the input of one tool the model is required to call, which is what holds
 * it to the diagnosis schema.
 */

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const TOOL = "report_diagnosis";

export async function askAnthropic(
  config: DiagnosisConfig,
  system: string,
  user: string,
  options: AskOptions,
): Promise<unknown> {
  const response = await options.fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 2048,
      temperature: TEMPERATURE,
      system,
      tools: [{ name: TOOL, description: "Report the diagnosis.", input_schema: DIAGNOSIS_JSON_SCHEMA }],
      tool_choice: { type: "tool", name: TOOL },
      messages: [{ role: "user", content: user }],
    }),
    signal: options.signal,
  });
  const body = (await response.json().catch(() => null)) as AnthropicResponse | null;
  if (!response.ok) {
    // Anthropic's error type ("overloaded_error") says what was wrong; its
    // message is not kept.
    const type = body?.error?.type;
    throw new ProviderError(`HTTP ${response.status}${type ? ` ${type}` : ""}`);
  }
  const call = body?.content?.find((block) => block.type === "tool_use" && block.name === TOOL);
  if (!call) throw new ProviderError(`no answer (${body?.stop_reason ?? "no content"})`);
  return call.input;
}

type AnthropicResponse = {
  content?: Array<{ type: string; name?: string; input?: unknown }>;
  stop_reason?: string;
  error?: { type?: string };
};
