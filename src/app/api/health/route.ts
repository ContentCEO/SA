import { previewGuard } from "@/config/environment-guard";

export const dynamic = "force-dynamic";

export function GET() {
  // Check 26 P2: a preview pointed at production says so, so the deploy check shows it.
  if (previewGuard().length > 0) {
    return Response.json(
      { ok: false, service: "squared-away", reason: "preview_uses_production" },
      { status: 503 },
    );
  }
  return Response.json({
    ok: true,
    service: "squared-away",
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
  });
}
