import { createHash, timingSafeEqual } from "node:crypto";
import { e2eHookSecret, isLoopbackHostname } from "@/config/e2e";
import { hookStep, runHookStep } from "@/server/test-hooks";

export const dynamic = "force-dynamic";

const notFound = () => new Response(null, { status: 404 });

/** Constant time whatever the lengths: compare fixed-size digests. */
function secretMatches(expected: string, received: string | null): boolean {
  if (!received) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(received).digest();
  return timingSafeEqual(a, b);
}

/**
 * Local end-to-end tests only (Milestone 11): runs one job step (src/server/test-hooks.ts)
 * without Inngest. It looks absent — 404, before anything else is read — unless ALL hold:
 * the app is in local e2e mode with a hook secret of ≥32 characters (src/config/e2e.ts:
 * never on Vercel, only with loopback fakes and a loopback database), the request was made to
 * localhost / 127.0.0.1 / [::1] (on Vercel the host is always the deploy's domain), and the
 * `x-e2e-hook-secret` header matches. POST only.
 *
 * 200 = the step did its job; 409 = it ran but stopped (skipped, read-only, not due…) with its
 * real status in the body; 400 = a malformed step; 500 = `{ error: <error name> }` only.
 */
export async function POST(request: Request) {
  const secret = e2eHookSecret();
  if (!secret) return notFound();
  let hostname: string;
  try {
    hostname = new URL(request.url).hostname;
  } catch {
    return notFound();
  }
  if (!isLoopbackHostname(hostname)) return notFound();
  if (!secretMatches(secret, request.headers.get("x-e2e-hook-secret"))) return notFound();

  const parsed = hookStep.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_step" }, { status: 400 });
  try {
    const result = await runHookStep(parsed.data);
    return Response.json(result, {
      status: result.ok ? 200 : 409,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    console.error("test_hook_failed", { step: parsed.data.step, error: name });
    return Response.json({ error: name }, { status: 500 });
  }
}
