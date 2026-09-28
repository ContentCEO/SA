export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    ok: true,
    service: "squared-away",
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
  });
}
