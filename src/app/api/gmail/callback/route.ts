import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { appUrl } from "@/lib/app-url";
import { MissingScopesError, NoGmailError } from "@/mailbox/connector";
import { createGmailConnector } from "@/mailbox/gmail/connector";
import {
  GMAIL_STATE_COOKIE,
  gmailRedirectPath,
  parseStateCookie,
  statesMatch,
} from "@/mailbox/gmail/oauth-state";
import { getWorkspaceForUser } from "@/server/accounts";
import { enqueue, mailboxConnected } from "@/jobs/client";
import {
  listMailboxes,
  MailboxInUseError,
  MailboxLimitError,
  saveConnectedMailbox,
} from "@/server/mailboxes";
import { getBusinessProfile } from "@/server/profile";
import { termsRequiredResponse } from "@/server/session";
import { termsAccepted } from "@/server/terms";

export const dynamic = "force-dynamic";

function to(path: string) {
  return NextResponse.redirect(appUrl(path), { status: 303 });
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return to("/");
  // Not agreed to the current terms (Davi, 2026-10-15): 403, and nothing from Google is saved.
  if (!(await termsAccepted(session.user.id))) return termsRequiredResponse();

  const params = request.nextUrl.searchParams;
  const cookieStore = await cookies();
  const cookie = parseStateCookie(cookieStore.get(GMAIL_STATE_COOKIE)?.value);
  cookieStore.delete({ name: GMAIL_STATE_COOKIE, path: "/api/gmail" });

  if (!statesMatch(cookie?.state, params.get("state"))) return to("/connect?error=expired");
  const connect = cookie!.connect;
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
    // Check 42 P3: the owner meant a different Gmail than Google sent back. Nothing is saved
    // (and the token isn't revoked: that address may be live here or in another account).
    // Only mailbox ids go in the URL, never an address.
    const own = await listMailboxes(workspace.id);
    const picked = own.find((m) => m.email.toLowerCase() === result.email.toLowerCase());
    if (connect.mode === "add" && picked) {
      return to(`/connect?error=already_connected&mailbox=${picked.id}`);
    }
    if (connect.mode === "reconnect") {
      const card = own.find((m) => m.id === connect.mailboxId);
      if (card && card.email.toLowerCase() !== result.email.toLowerCase()) {
        return to(
          `/connect?error=wrong_account&mailbox=${card.id}${picked ? `&picked=${picked.id}` : ""}`,
        );
      }
    }
    const mailbox = await saveConnectedMailbox(workspace, result);
    await enqueue(mailboxConnected.create({ mailboxId: mailbox.id }));
    // First time through: continue onboarding with the business profile.
    const profile = await getBusinessProfile(workspace.id);
    return to(profile?.completedAt ? "/settings/gmail?done=connected" : "/welcome/profile");
  } catch (err) {
    if (err instanceof MissingScopesError) return to("/connect?error=scopes");
    if (err instanceof NoGmailError) {
      console.error("gmail_connect_no_mailbox", { name: "NoGmailError" });
      return to("/connect?error=no_gmail");
    }
    if (err instanceof MailboxLimitError) return to("/settings/gmail?error=limit");
    // Check 25 P7: connected to another Squared Away account. Nothing was saved. The new token
    // is NOT revoked: revoking a Google grant can end the other account's access to that same
    // inbox too, and that account is working.
    if (err instanceof MailboxInUseError) return to("/connect?error=in_use");
    // No token or email content in logs — just the kind of failure.
    console.error("gmail_connect_failed", { name: (err as Error).name });
    return to("/connect?error=failed");
  }
}
