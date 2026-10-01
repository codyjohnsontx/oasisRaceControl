import { z } from "zod";
import { withTransaction } from "@/lib/db";
import { refuseCrossOriginRequest } from "@/lib/http";
import { scheduleMonitor } from "@/lib/monitor/run";
import { nextVenueMidnightSql } from "@/lib/monitor/store";
import { getStaffUser } from "@/lib/staff";

/**
 * Staff's hand on event mode (docs/monitoring.md). `on` and `off` override
 * whatever the TV boards say until venue midnight - no longer, so a forgotten
 * "Start event" cannot keep the 20-minute updates posting all week; `auto`
 * hands the decision back to the boards. The staff Rig health page, not yet
 * built, will call it; the answer says when the override lapses.
 */
const body = z.object({
  mode: z.enum(["on", "off", "auto"]),
  reason: z.string().trim().max(300).optional(),
});

export async function POST(request: Request) {
  // It changes what the whole venue's channel is told, so the staff cookie
  // alone is not proof the staff page sent it (refuseCrossOriginRequest).
  const refused = refuseCrossOriginRequest(request);
  if (refused) return refused;

  const staff = await getStaffUser();
  if (!staff) return Response.json({ error: "forbidden" }, { status: 403 });

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
  const input = parsed.data;
  const override = input.mode === "auto" ? null : input.mode;

  try {
    const expiresAt = await withTransaction(async (client) => {
      const { rows } = await client.query<{ expires_at: Date | null }>(
        `insert into monitor_state (id, event_mode_override, override_set_by, override_expires_at)
         values (1, $1::text, case when $1::text is null then null else $2::uuid end,
                 case when $1::text is null then null else ${nextVenueMidnightSql("now()")} end)
         on conflict (id) do update set
           event_mode_override = excluded.event_mode_override,
           override_set_by = excluded.override_set_by,
           override_expires_at = excluded.override_expires_at
         returning override_expires_at as expires_at`,
        [override, staff.userId],
      );
      const expires = rows[0]?.expires_at ?? null;
      await client.query(
        `insert into audit_log (staff_user_id, action, target_type, target_id, reason, detail)
         values ($1, 'event_mode_override', 'monitor_state', '1', $2, $3)`,
        [staff.userId, input.reason ?? null, { mode: input.mode, expiresAt: expires?.toISOString() ?? null }],
      );
      return expires;
    });

    // So the flip is posted now rather than at the next heartbeat or tick.
    scheduleMonitor();
    return Response.json({ mode: input.mode, expiresAt: expiresAt?.toISOString() ?? null });
  } catch (error) {
    console.error("[staff/event-mode] failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
