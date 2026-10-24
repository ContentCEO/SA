"use server";

import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { mailboxes } from "@/db/schema";
import { appUrl } from "@/lib/app-url";
import { createGmailConnector } from "@/mailbox/gmail/connector";
import { outlookOffered } from "@/config/outlook";
import { createOutlookConnector } from "@/mailbox/outlook/connector";
import {
  newPkceVerifier,
  OUTLOOK_STATE_COOKIE,
  OUTLOOK_STATE_MAX_AGE_SECONDS,
  outlookRedirectPath,
  outlookStateCookieValue,
  pkceChallenge,
} from "@/mailbox/outlook/oauth-state";
import {
  GMAIL_STATE_COOKIE,
  GMAIL_STATE_MAX_AGE_SECONDS,
  gmailRedirectPath,
  isUuid,
  newOAuthState,
  stateCookieValue,
  type ConnectMode,
} from "@/mailbox/gmail/oauth-state";
import { hitLimit } from "@/server/rate-limit";
import { requireOwner } from "@/server/session";

/**
 * Off to Google. Check 42 P3: the hidden `mode` says which Gmail the owner meant — their first
 * (Google is hinted the sign-in address), another one (no hint, Google's account chooser), or
 * reconnecting one card (hinted that card's address, read here from the workspace's own
 * mailboxes; an address from the form is never trusted).
 */
export async function startGmailConnect(form?: FormData) {
  const { session, workspace } = await requireOwner();
  if (!(await hitLimit("connect", workspace.id)).allowed) redirect("/connect?error=busy");
  const asked = form?.get("mode");
  const mailboxId = form?.get("mailboxId");
  let connect: ConnectMode = { mode: "first" };
  let loginHint = session?.user?.email ?? undefined;
  if (asked === "add") {
    connect = { mode: "add" };
    loginHint = undefined;
  } else if (asked === "reconnect" && isUuid(mailboxId)) {
    const [box] = await db()
      .select({ id: mailboxes.id, email: mailboxes.email })
      .from(mailboxes)
      .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.workspaceId, workspace.id)));
    if (box) {
      connect = { mode: "reconnect", mailboxId: box.id };
      loginHint = box.email;
    }
  }
  const state = newOAuthState();
  (await cookies()).set(GMAIL_STATE_COOKIE, stateCookieValue(state, connect), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/gmail",
    maxAge: GMAIL_STATE_MAX_AGE_SECONDS,
  });
  redirect(
    createGmailConnector().authorizationUrl({
      state,
      redirectUri: appUrl(gmailRedirectPath),
      loginHint,
      prompt: connect.mode === "add" ? "consent select_account" : "consent",
    }),
  );
}

/**
 * Plan #49: off to Microsoft, only while Outlook is offered (FEATURE_OUTLOOK + the Azure app's
 * credentials); otherwise back to the Connect screen with nothing set. The same modes as Gmail
 * (a reconnect only for one of this workspace's own Outlook mailboxes), the same rate limit,
 * and a PKCE verifier kept next to the state in an httpOnly cookie scoped to /api/outlook.
 */
export async function startOutlookConnect(form?: FormData) {
  const { session, workspace } = await requireOwner();
  if (!outlookOffered()) redirect("/connect");
  if (!(await hitLimit("connect", workspace.id)).allowed) redirect("/connect?error=busy");
  const asked = form?.get("mode");
  const mailboxId = form?.get("mailboxId");
  let connect: ConnectMode = { mode: "first" };
  let loginHint = session?.user?.email ?? undefined;
  if (asked === "add") {
    connect = { mode: "add" };
    loginHint = undefined;
  } else if (asked === "reconnect" && isUuid(mailboxId)) {
    const [box] = await db()
      .select({ id: mailboxes.id, email: mailboxes.email })
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.id, mailboxId),
          eq(mailboxes.workspaceId, workspace.id),
          eq(mailboxes.provider, "outlook"),
        ),
      );
    if (box) {
      connect = { mode: "reconnect", mailboxId: box.id };
      loginHint = box.email;
    }
  }
  const state = newOAuthState();
  const verifier = newPkceVerifier();
  (await cookies()).set(OUTLOOK_STATE_COOKIE, outlookStateCookieValue(state, connect, verifier), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/outlook",
    maxAge: OUTLOOK_STATE_MAX_AGE_SECONDS,
  });
  redirect(
    createOutlookConnector().authorizationUrl({
      state,
      redirectUri: appUrl(outlookRedirectPath),
      loginHint,
      prompt: connect.mode === "add" ? "consent select_account" : "consent",
      codeChallenge: pkceChallenge(verifier),
    }),
  );
}
