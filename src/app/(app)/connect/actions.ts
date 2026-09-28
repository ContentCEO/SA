"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { appUrl } from "@/lib/app-url";
import { createGmailConnector } from "@/mailbox/gmail/connector";
import {
  GMAIL_STATE_COOKIE,
  GMAIL_STATE_MAX_AGE_SECONDS,
  gmailRedirectPath,
  newOAuthState,
} from "@/mailbox/gmail/oauth-state";
import { requireOwner } from "@/server/session";

export async function startGmailConnect() {
  const { session } = await requireOwner();
  const state = newOAuthState();
  (await cookies()).set(GMAIL_STATE_COOKIE, state, {
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
      loginHint: session?.user?.email ?? undefined,
    }),
  );
}
