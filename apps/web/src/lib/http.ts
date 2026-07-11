import type { z } from "zod";

/**
 * Parses and validates a JSON request body. Returns the validated data, or a
 * ready-to-return 400 Response for malformed JSON / schema mismatches.
 */
export async function parseJsonBody<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
): Promise<z.infer<Schema> | Response> {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }
  return parsed.data;
}
