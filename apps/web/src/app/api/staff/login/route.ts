import { z } from "zod";
import bcrypt from "bcryptjs";
import { queryOne } from "@/lib/db";
import { setStaffSession } from "@/lib/staff";
import { parseJsonBody } from "@/lib/http";
import { rateLimit, clientIp } from "@/lib/rate-limit";

const body = z.object({ email: z.email(), password: z.string().min(8).max(200) });

// Same timing-equalization trick as driver login.
const DUMMY_HASH = "$2b$10$KWAPErVpVeGiV16GbCVpheKt9v50acLl2VRdevylCNm7B6L4SC7ni";

export async function POST(request: Request) {
  if (!rateLimit(`staff-login:${clientIp(request)}`, 10, 60_000)) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const input = await parseJsonBody(request, body);
  if (input instanceof Response) return input;

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
