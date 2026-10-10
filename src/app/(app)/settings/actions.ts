"use server";

import { cookies } from "next/headers";
import { OFFLINE_COOKIE } from "@/lib/device-prefs";
import { redirect } from "next/navigation";
import { z } from "zod";
import { signOut } from "@/auth";
import { createGmailConnector } from "@/mailbox/gmail/connector";
import { deleteAccount, SubscriptionCancelError } from "@/server/account-deletion";
import { disconnectMailbox } from "@/server/mailboxes";
import { requireOwner } from "@/server/session";

const input = z.object({ mailboxId: z.string().uuid() });

export async function disconnectMailboxAction(formData: FormData) {
  // Re-check who's asking inside the action — page checks don't cover direct POSTs.
  const { workspace } = await requireOwner();
  const parsed = input.safeParse({ mailboxId: formData.get("mailboxId") });
  if (!parsed.success) redirect("/settings?error=unknown");
  const ok = await disconnectMailbox(workspace.id, parsed.data.mailboxId, createGmailConnector());
  redirect(ok ? "/settings?done=disconnected" : "/settings?error=unknown");
}

export async function deleteAccountAction() {
  const { userId } = await requireOwner();
  try {
    await deleteAccount(userId, createGmailConnector());
  } catch (err) {
    if (err instanceof SubscriptionCancelError) redirect("/settings?error=delete_billing");
    throw err;
  }
  (await cookies()).delete(OFFLINE_COOKIE);
  await signOut({ redirectTo: "/goodbye" });
}
