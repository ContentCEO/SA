import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { getWorkspaceForUser } from "@/server/accounts";
import { replacePushSubscription } from "@/server/push-alerts";
import { hitLimit } from "@/server/rate-limit";
import { termsRequiredResponse } from "@/server/session";
import { termsAccepted } from "@/server/terms";

export const dynamic = "force-dynamic";

function sameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Check 19 P5: the browser renewed this phone's push subscription (the service worker's
 * `pushsubscriptionchange`), so the new address replaces the old one. `{ oldEndpoint,
 * newEndpoint }`, both real push services (isPushEndpoint); the owner's own session only.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  const workspace = session?.user?.id ? await getWorkspaceForUser(session.user.id) : null;
  if (!workspace) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  // Not agreed to the current terms (Davi, 2026-10-15): 403, never a redirect.
  if (!(await termsAccepted(session!.user.id))) return termsRequiredResponse();
  // CSRF: only the app's own service worker (same origin) may change it.
  if (!sameOrigin(request.headers.get("origin"), request.headers.get("host"))) {
    return NextResponse.json({ error: "Cross-site request refused." }, { status: 403 });
  }
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
  const payload = (await request.json().catch(() => null)) as {
    oldEndpoint?: unknown;
    newEndpoint?: unknown;
  } | null;
  const ok = await replacePushSubscription(
    workspace.id,
    payload?.oldEndpoint ?? null,
    payload?.newEndpoint,
  );
  if (!ok) return NextResponse.json({ error: "That isn't a push address." }, { status: 400 });
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
