import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { appUrl } from "@/lib/app-url";
import { MissingScopesError } from "@/mailbox/connector";
import { createGmailConnector } from "@/mailbox/gmail/connector";
import { GMAIL_STATE_COOKIE, gmailRedirectPath, statesMatch } from "@/mailbox/gmail/oauth-state";
import { getWorkspaceForUser } from "@/server/accounts";
import { enqueue, mailboxConnected } from "@/jobs/client";
import { MailboxLimitError, saveConnectedMailbox } from "@/server/mailboxes";
import { getBusinessProfile } from "@/server/profile";

export const dynamic = "force-dynamic";

function to(path: string) {
  return NextResponse.redirect(appUrl(path), { status: 303 });
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return to("/");

  const params = request.nextUrl.searchParams;
  const cookieStore = await cookies();
  const expected = cookieStore.get(GMAIL_STATE_COOKIE)?.value;
  cookieStore.delete({ name: GMAIL_STATE_COOKIE, path: "/api/gmail" });

  if (!statesMatch(expected, params.get("state"))) return to("/connect?error=expired");
  if (params.get("error")) return to("/connect?error=denied");

  const code = params.get("code");
  if (!code) return to("/connect?error=failed");

  const workspace = await getWorkspaceForUser(session.user.id);
  if (!workspace) return to("/");

  try {
    const result = await createGmailConnector().exchangeCode({
      code,
      redirectUri: appUrl(gmailRedirectPath),
    });
    const mailbox = await saveConnectedMailbox(workspace, result);
    await enqueue(mailboxConnected.create({ mailboxId: mailbox.id }));
    // First time through: continue onboarding with the business profile.
    const profile = await getBusinessProfile(workspace.id);
    return to(profile?.completedAt ? "/settings?done=connected" : "/welcome/profile");
  } catch (err) {
    if (err instanceof MissingScopesError) return to("/connect?error=scopes");
    if (err instanceof MailboxLimitError) return to("/settings?error=limit");
    // No token or email content in logs — just the kind of failure.
    console.error("gmail_connect_failed", { name: (err as Error).name });
    return to("/connect?error=failed");
  }
}
