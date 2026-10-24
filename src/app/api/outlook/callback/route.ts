import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { outlookOffered } from "@/config/outlook";
import { appUrl } from "@/lib/app-url";
import { MissingScopesError, NoOutlookMailboxError } from "@/mailbox/connector";
import { statesMatch } from "@/mailbox/gmail/oauth-state";
import { createOutlookConnector } from "@/mailbox/outlook/connector";
import {
  OUTLOOK_STATE_COOKIE,
  outlookRedirectPath,
  parseOutlookStateCookie,
} from "@/mailbox/outlook/oauth-state";
import { getWorkspaceForSession } from "@/server/accounts";
import { enqueue, mailboxConnected } from "@/jobs/client";
import {
  listMailboxes,
  MailboxInUseError,
  MailboxLimitError,
  MailboxProviderMismatchError,
  saveConnectedMailbox,
} from "@/server/mailboxes";
import { getBusinessProfile } from "@/server/profile";
import { termsRequiredResponse } from "@/server/session";
import { termsAccepted } from "@/server/terms";

export const dynamic = "force-dynamic";

function to(path: string) {
  return NextResponse.redirect(appUrl(path), { status: 303 });
}

/**
 * Plan #49: back from Microsoft's sign-in. The same rules as the Gmail callback: signed in,
 * terms agreed, the state compared in constant time, the PKCE verifier from the same cookie,
 * every permission or nothing saved. Off (FEATURE_OUTLOOK) → back to Connect, nothing read.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return to("/");
  if (!(await termsAccepted(session.user.id))) return termsRequiredResponse();
  if (!outlookOffered()) return to("/connect");
  const workspace = await getWorkspaceForSession(session.user);
  if (!workspace) return to("/");

  const params = request.nextUrl.searchParams;
  const cookieStore = await cookies();
  const cookie = parseOutlookStateCookie(cookieStore.get(OUTLOOK_STATE_COOKIE)?.value);
  cookieStore.delete({ name: OUTLOOK_STATE_COOKIE, path: "/api/outlook" });

  if (!statesMatch(cookie?.state, params.get("state"))) return to("/connect?error=expired");
  const connect = cookie!.connect;
  if (params.get("error")) return to("/connect?error=outlook_denied");

  const code = params.get("code");
  if (!code) return to("/connect?error=failed");

  try {
    const result = await createOutlookConnector().exchangeCode({
      code,
      redirectUri: appUrl(outlookRedirectPath),
      codeVerifier: cookie!.verifier,
    });
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
    const mailbox = await saveConnectedMailbox(workspace, result, "outlook");
    await enqueue(mailboxConnected.create({ mailboxId: mailbox.id }));
    const profile = await getBusinessProfile(workspace.id);
    return to(profile?.completedAt ? "/settings/gmail?done=connected" : "/welcome/profile");
  } catch (err) {
    if (err instanceof MissingScopesError) return to("/connect?error=outlook_scopes");
    if (err instanceof NoOutlookMailboxError) {
      console.error("outlook_connect_no_mailbox", { name: "NoOutlookMailboxError" });
      return to("/connect?error=no_outlook");
    }
    if (err instanceof MailboxLimitError) return to("/settings/gmail?error=limit");
    if (err instanceof MailboxInUseError) return to("/connect?error=in_use");
    if (err instanceof MailboxProviderMismatchError) return to("/connect?error=other_provider");
    console.error("outlook_connect_failed", { name: (err as Error).name });
    return to("/connect?error=failed");
  }
}
