"use server";

import { cookies } from "next/headers";
import { OFFLINE_COOKIE } from "@/lib/device-prefs";
import { redirect } from "next/navigation";
import { z } from "zod";
import { signOut } from "@/auth";
import { createGmailConnector } from "@/mailbox/gmail/connector";
import { deleteAccount, SubscriptionCancelError } from "@/server/account-deletion";
import { disconnectMailbox, InboxSwapError, swapPausedInbox } from "@/server/mailboxes";
import { hitLimit } from "@/server/rate-limit";
import { requireOwner } from "@/server/session";

const input = z.object({ mailboxId: z.string().uuid() });

export async function disconnectMailboxAction(formData: FormData) {
  // Re-check who's asking inside the action — page checks don't cover direct POSTs.
  const { workspace } = await requireOwner();
  const parsed = input.safeParse({ mailboxId: formData.get("mailboxId") });
  if (!parsed.success) redirect("/settings/gmail?error=unknown");
  const ok = await disconnectMailbox(workspace.id, parsed.data.mailboxId, createGmailConnector());
  redirect(ok ? "/settings/gmail?done=disconnected" : "/settings/gmail?error=unknown");
}

const swapInput = z.object({ resumeId: z.string().uuid(), pauseId: z.string().uuid() });

/**
 * Plan #47: "Switch this one on instead" on an inbox paused for being over the plan. The owner
 * picks which inbox pauses in its place; the plan's limit holds. Both ids are re-checked
 * against this workspace inside swapPausedInbox. Uses the Gmail-connect rate limit.
 */
export async function swapInboxAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const parsed = swapInput.safeParse({
    resumeId: formData.get("resumeId"),
    pauseId: formData.get("pauseId"),
  });
  if (!parsed.success) redirect("/settings/gmail?error=swap");
  if (!(await hitLimit("connect", workspace.id)).allowed) redirect("/settings/gmail?error=busy");
  try {
    await swapPausedInbox(workspace.id, parsed.data.resumeId, parsed.data.pauseId);
  } catch (err) {
    if (err instanceof InboxSwapError) redirect("/settings/gmail?error=swap");
    throw err;
  }
  redirect("/settings/gmail?done=swapped");
}

export async function deleteAccountAction() {
  const { userId } = await requireOwner();
  try {
    await deleteAccount(userId, createGmailConnector());
  } catch (err) {
    if (err instanceof SubscriptionCancelError) redirect("/settings/account?error=delete_billing");
    throw err;
  }
  (await cookies()).delete(OFFLINE_COOKIE);
  await signOut({ redirectTo: "/goodbye" });
}
