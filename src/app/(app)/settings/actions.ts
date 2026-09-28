"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createGmailConnector } from "@/mailbox/gmail/connector";
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
