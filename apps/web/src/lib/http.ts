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

/**
 * Refuses a state-changing request unless it is a JSON fetch from this site's
 * own origin. The staff cookie is SameSite=Lax, which keeps it off requests
 * from other sites but not from another origin on the same site, and
 * `request.json()` will parse a text/plain HTML form body that happens to be
 * valid JSON. Requiring a same-origin Origin header and a JSON content type
 * closes both: a form cannot send application/json, and a cross-origin fetch
 * that does is either preflighted and refused or carries a foreign Origin.
 * Browsers send Origin on every POST, so a missing one is refused too - no
 * browser-driven caller of these routes lacks it.
 *
 * Returns a ready-to-return response, or null when the request may proceed.
 * Call it before anything else in the handler, so a refused request costs no
 * session lookup, no hashing and no query.
 */
export function refuseCrossOriginRequest(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (origin === null || origin !== new URL(request.url).origin) {
    return Response.json({ error: "cross_origin" }, { status: 403 });
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";")[0]!.trim().toLowerCase() !== "application/json") {
    return Response.json({ error: "unsupported_media_type" }, { status: 415 });
  }
  return null;
}
