import { NextResponse, type NextRequest } from "next/server";
import { appUrl } from "@/lib/app-url";
import { verifiedStopLink } from "@/server/trial-email-links";
import { stopTrialEmails } from "@/server/trial-emails";

export const dynamic = "force-dynamic";

/**
 * "Stop these emails" in a trial email (Davi, 2026-10-16). One click: the link's own signature
 * (HMAC over the workspace id, keyed with AUTH_SECRET, compared in constant time) is the only
 * thing that lets it through — no sign-in needed, and it can only switch trial emails off.
 * GET is the link; POST is the mail app's one-click button (List-Unsubscribe-Post).
 */
export async function GET(request: NextRequest) {
  const link = verifiedStopLink(request.nextUrl.searchParams);
  if (!link) return NextResponse.redirect(appUrl("/emails/stopped?link=bad"), { status: 303 });
  await stopTrialEmails(link.workspaceId, "link");
  return NextResponse.redirect(appUrl("/emails/stopped"), { status: 303 });
}

export async function POST(request: NextRequest) {
  const link = verifiedStopLink(request.nextUrl.searchParams);
  if (!link) return NextResponse.json({ error: "That link isn't valid." }, { status: 400 });
  await stopTrialEmails(link.workspaceId, "link");
  return NextResponse.json({ stopped: true });
}
