"use server";

import { cookies } from "next/headers";
import { OFFLINE_COOKIE } from "@/lib/device-prefs";
import { redirect } from "next/navigation";
import { z } from "zod";
import { signOut } from "@/auth";
import { createGmailConnector } from "@/mailbox/gmail/connector";
import { deleteAccount, SubscriptionCancelError } from "@/server/account-deletion";
import { signOutEverywhere } from "@/server/sign-out-everywhere";
import { disconnectMailbox, listMailboxes } from "@/server/mailboxes";
import { hitLimit } from "@/server/rate-limit";
import { deleteConfirmed, DELETE_RECENT_SIGN_IN_MINUTES } from "@/server/account-deletion-rules";
import { requireOwner, requireRecentSignIn } from "@/server/session";
import { swapPlanMailbox } from "@/server/mailbox-plan";

const input = z.object({ mailboxId: z.string().uuid() });

export async function disconnectMailboxAction(formData: FormData) {
  // Re-check who's asking inside the action — page checks don't cover direct POSTs.
  const { workspace } = await requireOwner();
  const parsed = input.safeParse({ mailboxId: formData.get("mailboxId") });
  if (!parsed.success) redirect("/settings/gmail?error=unknown");
  // Plan #49: an Outlook mailbox's notice says where to remove the app at Microsoft.
  const provider = (await listMailboxes(workspace.id)).find(
    (m) => m.id === parsed.data.mailboxId,
  )?.provider;
  const ok = await disconnectMailbox(workspace.id, parsed.data.mailboxId, createGmailConnector());
  redirect(
    ok
      ? `/settings/gmail?done=${provider === "outlook" ? "disconnected_outlook" : "disconnected"}`
      : "/settings/gmail?error=unknown",
  );
}

/**
 * "Use this one instead" (2026-10-16): a Gmail address paused on the plan comes on, and the one
 * named in `replaceId` is paused in its place. The server re-checks the plan's limit.
 */
export async function swapMailboxAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const parsed = z
    .object({ mailboxId: z.string().uuid(), replaceId: z.string().uuid().nullable() })
    .safeParse({
      mailboxId: formData.get("mailboxId"),
      replaceId: formData.get("replaceId") || null,
    });
  if (!parsed.success) redirect("/settings/gmail?error=unknown");
  // The Gmail-connect rate limit (plan #47's swap had one; kept at the merge).
  if (!(await hitLimit("connect", workspace.id)).allowed) redirect("/settings/gmail?error=busy");
  const r = await swapPlanMailbox(workspace.id, parsed.data.mailboxId, parsed.data.replaceId);
  if (r === "swapped" || r === "resumed") redirect(`/settings/gmail?done=${r}`);
  redirect(r === "choose" ? "/settings/gmail?error=choose" : "/settings/gmail?error=unknown");
}

export async function deleteAccountAction(formData: FormData) {
  const { userId } = await requireOwner();
  // Check 26 P4: a fresh Google sign-in and the typed word, both checked here on the server —
  // a direct POST that skips the screen's confirmation deletes nothing.
  await requireRecentSignIn(DELETE_RECENT_SIGN_IN_MINUTES);
  if (!deleteConfirmed(formData.get("confirm"))) redirect("/settings/account?error=confirm");
  try {
    await deleteAccount(userId, createGmailConnector());
  } catch (err) {
    if (err instanceof SubscriptionCancelError) redirect("/settings/account?error=delete_billing");
    throw err;
  }
  (await cookies()).delete(OFFLINE_COOKIE);
  await signOut({ redirectTo: "/goodbye" });
}

/**
 * Check 26 P3: "Sign out of every phone and computer" (a lost phone, a shared shop computer).
 * Every sign-in on the account stops working on its next request; then this device signs out.
 */
export async function signOutEverywhereAction() {
  const { workspace } = await requireOwner();
  await signOutEverywhere(workspace.id, "owner");
  (await cookies()).delete(OFFLINE_COOKIE);
  await signOut({ redirectTo: "/signin?done=everywhere" });
}
