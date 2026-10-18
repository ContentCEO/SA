"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { signOut } from "@/auth";
import { AGREE_FIELD, AGREE_REQUIRED_MESSAGE } from "@/config/legal";
import { OFFLINE_COOKIE } from "@/lib/device-prefs";
import { createGmailConnector } from "@/mailbox/gmail/connector";
import { deleteAccount, SubscriptionCancelError } from "@/server/account-deletion";
import { CheckoutNotAllowedError, createPortal } from "@/server/billing";
import { disconnectMailbox } from "@/server/mailboxes";
import { hitLimit } from "@/server/rate-limit";
import { deleteConfirmed, DELETE_RECENT_SIGN_IN_MINUTES } from "@/server/account-deletion-rules";
import { requireRecentSignIn, requireSignedIn } from "@/server/session";
import { recordTermsAcceptance } from "@/server/terms";
import { agreed, type AgreeState, safeNextPath } from "@/server/terms-rules";

/**
 * "Agree and continue" on /welcome/terms (Davi, 2026-10-15). The box is checked here on the
 * server; then the acceptance (time and version) goes on the account and they go back where
 * they were heading — a path on this site only (safeNextPath), else the queue.
 */
export async function agreeToTermsAction(
  _prev: AgreeState,
  formData: FormData,
): Promise<AgreeState> {
  const { userId } = await requireSignedIn();
  if (!agreed(formData.get(AGREE_FIELD))) return { error: AGREE_REQUIRED_MESSAGE };
  await recordTermsAcceptance(userId);
  redirect(safeNextPath(formData.get("next")));
}

/*
 * The ways out for someone who won't agree to new terms. The terms they already agreed to (and
 * the privacy policy) promise they can cancel, disconnect Gmail or delete their account at any
 * time, so refusing new terms must never take those away. Each runs the same server code as its
 * Settings or Plan & billing twin, behind the same confirmation, but is guarded by
 * requireSignedIn: requireOwner would send them straight back to this screen. They only end or
 * remove things; nothing here sends, drafts or changes a setting.
 */

/** Delete my account, from the terms screen. Same order and rules as Settings'. */
export async function deleteAccountFromTermsAction(formData: FormData) {
  const { userId } = await requireSignedIn();
  // Check 26 P4: the same server-side checks as Settings' Delete my account.
  await requireRecentSignIn(DELETE_RECENT_SIGN_IN_MINUTES);
  if (!deleteConfirmed(formData.get("confirm"))) redirect("/welcome/terms?error=confirm");
  try {
    await deleteAccount(userId, createGmailConnector());
  } catch (err) {
    if (err instanceof SubscriptionCancelError) redirect("/welcome/terms?error=delete_billing");
    throw err;
  }
  (await cookies()).delete(OFFLINE_COOKIE);
  await signOut({ redirectTo: "/goodbye" });
}

const mailboxInput = z.object({ mailboxId: z.string().uuid() });

/** Disconnect Gmail, from the terms screen: remove our access at Google, then our copy. */
export async function disconnectMailboxFromTermsAction(formData: FormData) {
  const { workspace } = await requireSignedIn();
  const parsed = mailboxInput.safeParse({ mailboxId: formData.get("mailboxId") });
  if (!parsed.success) redirect("/welcome/terms?error=unknown");
  const ok = await disconnectMailbox(workspace.id, parsed.data.mailboxId, createGmailConnector());
  redirect(ok ? "/welcome/terms?done=disconnected" : "/welcome/terms?error=unknown");
}

/** Stripe's billing page (to cancel the plan), from the terms screen; it comes back here. */
export async function openPortalFromTermsAction() {
  const { workspace } = await requireSignedIn();
  if (!(await hitLimit("billing", workspace.id)).allowed) redirect("/welcome/terms?error=busy");
  let url: string;
  try {
    url = await createPortal(workspace, "/welcome/terms");
  } catch (err) {
    if (err instanceof CheckoutNotAllowedError) redirect("/welcome/terms?error=unknown");
    throw err;
  }
  redirect(url);
}
