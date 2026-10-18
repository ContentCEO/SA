import { NextResponse, type NextRequest } from "next/server";
import { previewGuard } from "@/config/environment-guard";
import { alertIfJobsStopped, deepHealth, secretMatches } from "@/server/health-deep";

export const dynamic = "force-dynamic";

/**
 * Check 1 P4: database + background jobs, for an uptime monitor (docs/SETUP.md). Answered only
 * with the HEALTH_TOKEN (header `x-health-token` or `?token=`); anything else is a 404. 503 when
 * the jobs are over 30 minutes stale (and Davi gets one email an hour) or the database is down.
 * No ids, counts of minutes only.
 */
const tokenOf = (request: NextRequest) =>
  request.headers.get("x-health-token") ?? request.nextUrl.searchParams.get("token");

export async function GET(request: NextRequest) {
  if (!secretMatches(process.env.HEALTH_TOKEN, tokenOf(request))) {
    return new NextResponse(null, { status: 404 });
  }
  if (previewGuard().length > 0) {
    return NextResponse.json({ db: "unknown", reason: "preview_uses_production" }, { status: 503 });
  }
  let health;
  try {
    health = await deepHealth();
  } catch (err) {
    console.error("health_deep_failed", { error: err instanceof Error ? err.name : "unknown" });
    return NextResponse.json({ db: "down" }, { status: 503 });
  }
  if (health.jobs === "stale") {
    try {
      await alertIfJobsStopped(health);
    } catch (err) {
      console.error("jobs_alert_failed", { error: err instanceof Error ? err.name : "unknown" });
    }
  }
  return NextResponse.json(health, { status: health.jobs === "ok" ? 200 : 503 });
}
