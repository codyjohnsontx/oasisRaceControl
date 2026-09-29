import { refuseCrossOriginRequest } from "@/lib/http";
import { runMonitor } from "@/lib/monitor/run";
import { getStaffUser } from "@/lib/staff";

/**
 * "Run checks now" on the staff Rig health page: one monitor evaluation, the
 * same one a heartbeat or the outside clock's tick runs, throttled with all
 * of them. `evaluated: false` means one ran moments ago, so the page already
 * shows its result. The tick route itself is not called: it answers only the
 * outside clock's CRON_SECRET, which no browser should hold.
 */
export async function POST(request: Request) {
  // An evaluation can post to the venue's channel.
  const refused = refuseCrossOriginRequest(request);
  if (refused) return refused;

  const staff = await getStaffUser();
  if (!staff) return Response.json({ error: "forbidden" }, { status: 403 });

  try {
    return Response.json(await runMonitor());
  } catch (error) {
    console.error("[staff/monitor/run] evaluation failed", (error as Error).message);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}
