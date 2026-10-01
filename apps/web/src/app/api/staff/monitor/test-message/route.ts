import { refuseCrossOriginRequest } from "@/lib/http";
import { postDiscord } from "@/lib/monitor/discord";
import { noteMessage } from "@/lib/monitor/messages";
import { getStaffUser } from "@/lib/staff";

/**
 * "Send test message to Discord" on the staff Rig health page: proves the
 * webhook works before an event needs it. The answer says what actually
 * happened - sent, not configured on this deployment, or refused by Discord
 * and why - so a broken webhook is found now and not from an alert that
 * never arrives.
 */
export async function POST(request: Request) {
  // It posts to the venue's channel, so the staff cookie alone is not proof
  // the staff page sent it (refuseCrossOriginRequest).
  const refused = refuseCrossOriginRequest(request);
  if (refused) return refused;

  const staff = await getStaffUser();
  if (!staff) return Response.json({ error: "forbidden" }, { status: 403 });

  const result = await postDiscord(noteMessage(`🔧 Test message from /staff/rigs by ${staff.displayName}`));
  switch (result.status) {
    case "sent":
      return Response.json({ status: "sent" });
    case "not_configured":
      return Response.json({ status: "not_configured" }, { status: 503 });
    case "failed":
      return Response.json({ status: "failed", reason: result.reason }, { status: 502 });
  }
}
