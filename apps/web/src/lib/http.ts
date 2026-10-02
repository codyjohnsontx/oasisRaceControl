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
 * The Origin is compared with the host the browser addressed (X-Forwarded-Host,
 * else Host), as Next's own server-action check does, not with `request.url`:
 * under `next start` and the standalone server that URL is built from the bind
 * address, so a staff page opened on a LAN IP or a forwarded port would never
 * match it.
 *
 * Returns a ready-to-return response, or null when the request may proceed.
 * Call it before anything else in the handler, so a refused request costs no
 * session lookup, no hashing and no query.
 */
export function refuseCrossOriginRequest(request: Request): Response | null {
  if (!originMatchesHost(request.headers)) {
    return Response.json({ error: "cross_origin" }, { status: 403 });
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";")[0]!.trim().toLowerCase() !== "application/json") {
    return Response.json({ error: "unsupported_media_type" }, { status: 415 });
  }
  return null;
}

function originMatchesHost(headers: Headers): boolean {
  const origin = headers.get("origin");
  const host = headers.get("x-forwarded-host")?.split(",")[0]?.trim() || headers.get("host");
  if (!origin || !host || !URL.canParse(origin)) return false;
  return new URL(origin).host === host.toLowerCase();
}

/**
 * The request body as text, or null once it passes `maxBytes`. Reads the stream
 * and stops there rather than buffering whatever was sent, and trusts a
 * Content-Length only to refuse early, never to accept.
 */
export async function readBody(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** `text` parsed as JSON, or null when it is not JSON - which no schema here accepts. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
