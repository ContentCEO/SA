import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getWorkspaceForUser } from "@/server/accounts";
import { badgeCount } from "@/server/badge";
import { hitLimit } from "@/server/rate-limit";
import { termsRequiredResponse } from "@/server/session";
import { termsAccepted } from "@/server/terms";

export const dynamic = "force-dynamic";

/**
 * Plan #38: the number for the home-screen icon, and nothing else — `{ count }`. Light on
 * purpose (plan M8 A32): signed-in screens ask at most once a minute, so it runs only the
 * content-free queue counts. Signed out → 401, which clears the badge.
 */
export async function GET() {
  const session = await auth();
  const workspace = session?.user?.id ? await getWorkspaceForUser(session.user.id) : null;
  if (!workspace) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  // Not agreed to the current terms (Davi, 2026-10-15): 403, never a redirect.
  if (!(await termsAccepted(session!.user.id))) return termsRequiredResponse();
  // M11 C8: a script polling this can't hammer the database (phones ask far less often).
  const limit = await hitLimit("poll", workspace.id);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSec), "Cache-Control": "no-store" },
      },
    );
  }
  const count = await badgeCount(workspace, new Date());
  return NextResponse.json({ count }, { headers: { "Cache-Control": "no-store" } });
}
