import { createHash, timingSafeEqual } from "node:crypto";
import { runMonitor, scheduleDiagnoses } from "@/lib/monitor/run";
import { countOpenAlerts } from "@/lib/monitor/store";
import { probeDatabase } from "@/lib/readiness";

/**
 * The monitor's external clock. Rig heartbeats evaluate the rules as they
 * arrive, but a venue whose every rig has gone dark sends none, so a free
 * scheduler outside Vercel (cron-job.org, once a minute in venue hours) calls
 * this and the evaluation runs anyway - that is the tick that notices a
 * whole venue going quiet. Vercel Hobby cron cannot run more than once a day,
 * which is why the clock is outside.
 *
 * Secured by CRON_SECRET, sent as `Authorization: Bearer <secret>` - the name
 * and header Vercel's own cron sends, so moving the clock to a Vercel cron on
 * Pro changes no code. Without the variable the route refuses everything: an
 * unset secret must not read as "anyone may".
 *
 * The database is probed first under the readiness deadline, so an outage
 * answers 503 in about two seconds rather than hanging the scheduler's
 * request; the evaluation itself is throttled with every other one
 * (`evaluated: false` means one ran moments ago). An evaluation that ran is
 * followed by its urgent alerts' diagnoses once the answer has gone, so a
 * slow model never makes the scheduler's request time out.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    console.error("[monitor/tick] CRON_SECRET is not set; refusing every tick");
    return Response.json({ status: "unavailable", reason: "not configured" }, { status: 503 });
  }
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const database = await probeDatabase("monitor/tick");
  if (!database.ok) {
    return Response.json({ status: "unavailable", reason: database.reason }, { status: 503 });
  }

  try {
    const run = await runMonitor();
    if (run.evaluated) scheduleDiagnoses();
    return Response.json({
      status: "ok",
      evaluated: run.evaluated,
      activeAlerts: await countOpenAlerts(),
    });
  } catch (error) {
    console.error("[monitor/tick] evaluation failed", (error as Error).message);
    return Response.json({ status: "unavailable", reason: "evaluation failed" }, { status: 503 });
  }
}

/** Constant-time comparison, on digests so differing lengths leak nothing either. */
function bearerMatches(header: string | null, secret: string): boolean {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(match[1]!.trim()), digest(secret));
}
