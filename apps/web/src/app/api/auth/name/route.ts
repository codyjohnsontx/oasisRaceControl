import { queryOne } from "@/lib/db";
import { displayNameSchema } from "@/lib/driver-auth";
import { clientIp, rateLimit } from "@/lib/rate-limit";

/**
 * Whether a display name is already somebody's: `GET /api/auth/name?displayName=Mike`
 * answers `{ taken: true }` or `{ taken: false }`, nothing else.
 *
 * It exists for the rig's sign-in window, which asks for a name first and
 * then either asks for that driver's PIN or has a newcomer pick one, without
 * the "Raced here before?" question the first window asked. The lookup is
 * deliberately the least it can be. It reveals that a name exists, which the
 * owner accepted because every driver's name is already public on the
 * leaderboards, and `POST /api/auth/register` already answered the same
 * question with a 409 to anyone who asked it. It reveals nothing about the
 * row: not whether the name is a guest's, a banned driver's or one with no
 * PIN, so a stranger learns no more here than from the leaderboard, and the
 * login route's refusal stays the same for a wrong name and a wrong PIN.
 * Rate-limited per address like the other unauthenticated auth routes, and
 * generously, because the whole venue's rigs share one public address.
 *
 * The name is matched the way `register` and `login` match it: trimmed, and
 * case-insensitively, because `drivers.display_name` is citext - so a "mike"
 * typed for "Mike" is told the name is taken and goes on to the PIN that
 * signs Mike in.
 */
export async function GET(request: Request) {
  if (!rateLimit(`name:${clientIp(request)}`, 60, 60_000)) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const parsed = displayNameSchema.safeParse(new URL(request.url).searchParams.get("displayName"));
  if (!parsed.success) {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }

  try {
    const row = await queryOne<{ taken: boolean }>(
      "select exists(select 1 from drivers where display_name = $1) as taken",
      [parsed.data],
    );
    return Response.json({ taken: row?.taken === true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("[auth/name] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
