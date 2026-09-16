import { z } from "zod";
import bcrypt from "bcryptjs";
import { queryOne } from "@/lib/db";
import { setStaffSession } from "@/lib/staff";
import { parseJsonBody } from "@/lib/http";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { MIN_STAFF_PASSWORD_LENGTH } from "@/lib/staff-login-refusal";

// The minimum is checked below rather than in the schema so the refusal can
// name it. A body that fails the schema is answered "invalid_input", which
// cannot tell the operator which rule it broke - the whole point of the
// 2026-09-13 incident. Safe to say before any lookup: it describes what was
// typed, never whether an account exists.
const body = z.object({ email: z.email(), password: z.string().min(1).max(200) });

// Same timing-equalization trick as driver login. Cost 6 to match the
// gen_salt('bf') default used for seeded staff hashes, so the unknown-user
// path takes the same time as a real comparison.
const DUMMY_HASH = "$2b$06$vqi2yyu/tEilR7qgT5WOPOPUPtE3Y5gNq5JCC2j2rO/Ms3hlQwNiy";

export async function POST(request: Request) {
  if (!rateLimit(`staff-login:${clientIp(request)}`, 10, 60_000)) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const input = await parseJsonBody(request, body);
  if (input instanceof Response) return input;

  if (input.password.length < MIN_STAFF_PASSWORD_LENGTH) {
    return Response.json({ error: "password_too_short" }, { status: 400 });
  }

  try {
    const staff = await queryOne<{
      id: string;
      display_name: string;
      password_hash: string;
    }>(
      "select id, display_name, password_hash from staff_users where email = $1",
      [input.email],
    );

    if (!staff) {
      await bcrypt.compare(input.password, DUMMY_HASH);
      return Response.json({ error: "invalid_credentials" }, { status: 401 });
    }
    if (!(await bcrypt.compare(input.password, staff.password_hash))) {
      return Response.json({ error: "invalid_credentials" }, { status: 401 });
    }

    await setStaffSession({ userId: staff.id, displayName: staff.display_name });
    return Response.json({ displayName: staff.display_name });
  } catch (error) {
    console.error("[staff/login] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
