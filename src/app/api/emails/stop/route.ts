import { NextResponse, type NextRequest } from "next/server";
import { appUrl } from "@/lib/app-url";
import { turnOffDigest } from "@/server/digest";
import { hitLimit } from "@/server/rate-limit";
import { verifiedStopLink } from "@/server/trial-email-links";
import { stopTrialEmails } from "@/server/trial-emails";

export const dynamic = "force-dynamic";

/**
 * "Stop these emails" (trial emails, Davi 2026-10-16) and, since Check 18 P9, the morning email's
 * List-Unsubscribe (`k=digest`). The link's own signature (HMAC over the kind and the workspace
 * id, keyed with AUTH_SECRET, compared in constant time) is the only thing that lets it through:
 * no sign-in needed, and each kind can only switch its own emails off.
 *
 * - Trial (unchanged): GET is the footer link and stops them; POST is the mail app's button.
 * - Digest: GET never changes anything (link scanners open URLs); it shows a page with a button
 *   that POSTs here. POST (RFC 8058 one-click from the mail app, or that button) turns off only
 *   `digest_enabled`, logs once, and is rate-limited per link.
 */
export async function GET(request: NextRequest) {
  const link = verifiedStopLink(request.nextUrl.searchParams);
  if (!link) {
    // A bad morning-email link lands on that page's own "didn't work" (no w/s carried).
    const bad =
      request.nextUrl.searchParams.get("k") === "digest"
        ? "/emails/stopped?kind=digest"
        : "/emails/stopped?link=bad";
    return NextResponse.redirect(appUrl(bad), { status: 303 });
  }
  if (link.kind === "digest") {
    const qs = request.nextUrl.searchParams;
    const params = new URLSearchParams({ kind: "digest", w: qs.get("w")!, s: qs.get("s")! });
    return NextResponse.redirect(appUrl(`/emails/stopped?${params}`), { status: 303 });
  }
  await stopTrialEmails(link.workspaceId, "link");
  return NextResponse.redirect(appUrl("/emails/stopped"), { status: 303 });
}

export async function POST(request: NextRequest) {
  const link = verifiedStopLink(request.nextUrl.searchParams);
  if (!link) {
    const digest = request.nextUrl.searchParams.get("k") === "digest";
    return NextResponse.json({ error: "That link isn't valid." }, { status: digest ? 403 : 400 });
  }
  if (link.kind === "digest") {
    if (!(await hitLimit("emailStop", `digest:${link.workspaceId}`)).allowed) {
      return NextResponse.json({ error: "Too many tries." }, { status: 429 });
    }
    await turnOffDigest(link.workspaceId);
    // Our own page's button (a form) lands on the confirmation; a mail app gets a plain 200.
    const form = (request.headers.get("content-type") ?? "").includes("form");
    const body = form ? await request.formData().catch(() => null) : null;
    if (body?.get("from") === "page") {
      return NextResponse.redirect(appUrl("/emails/stopped?kind=digest&done=1"), { status: 303 });
    }
    return NextResponse.json({ stopped: true });
  }
  await stopTrialEmails(link.workspaceId, "link");
  return NextResponse.json({ stopped: true });
}
