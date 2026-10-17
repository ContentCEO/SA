import { NextResponse, type NextRequest } from "next/server";
import { alertIfJobsStopped, deepHealth, secretMatches } from "@/server/health-deep";

export const dynamic = "force-dynamic";

/**
 * Check 1 P4: Vercel Cron's backstop for the background jobs, so the alarm works even when
 * Inngest is down. Vercel sends `Authorization: Bearer <CRON_SECRET>`; without CRON_SECRET set
 * (or with any other value) this is a 404. Emails Davi at most once an hour.
 */
function bearerOf(request: NextRequest): string | null {
  const auth = request.headers.get("authorization");
  return auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
}

export async function GET(request: NextRequest) {
  if (!secretMatches(process.env.CRON_SECRET, bearerOf(request))) {
    return new NextResponse(null, { status: 404 });
  }
  try {
    const health = await deepHealth();
    const alert = await alertIfJobsStopped(health);
    return NextResponse.json({ jobs: health.jobs, alert });
  } catch (err) {
    console.error("jobs_check_failed", { error: err instanceof Error ? err.name : "unknown" });
    return NextResponse.json({ jobs: "unknown" }, { status: 503 });
  }
}
