import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { businessProfiles, mailboxes, users, workspaces, type Mailbox } from "@/db/schema";
import type { MailboxReader } from "@/mailbox/connector";
import { pickSenderName } from "./from-line-rules";
import { jobsAllowed } from "./lifecycle";
import { mailboxRunning } from "./mailbox-plan";
import { defaultReaderFor } from "./sync";

/**
 * Check 43 P3: the name customers see on this workspace's replies, read live (a change in
 * Settings reaches the next draft or edit). Never logged.
 */
export async function senderNameFor(workspaceId: string): Promise<string | null> {
  const [row] = await db()
    .select({
      fromName: businessProfiles.fromName,
      userName: users.name,
      businessName: workspaces.businessName,
    })
    .from(workspaces)
    .leftJoin(users, eq(users.id, workspaces.ownerUserId))
    .leftJoin(businessProfiles, eq(businessProfiles.workspaceId, workspaces.id))
    .where(eq(workspaces.id, workspaceId));
  return row ? pickSenderName(row) : null;
}

/**
 * Check 42 P4: read Gmail's send-as addresses for one mailbox and store them. Best effort:
 * a failure keeps what was stored (replies then go from the addresses we already knew, or the
 * connected address) and never fails the caller. Only the error's name is logged.
 */
export async function refreshSendAs(
  mailbox: Mailbox,
  readerFor: (m: Mailbox) => Pick<MailboxReader, "listSendAs"> = defaultReaderFor,
): Promise<"ok" | "skipped" | "failed"> {
  try {
    const reader = readerFor(mailbox);
    if (!reader.listSendAs) return "skipped";
    const list = (await reader.listSendAs()).slice(0, 50);
    await db().update(mailboxes).set({ sendAs: list }).where(eq(mailboxes.id, mailbox.id));
    return "ok";
  } catch (err) {
    console.error("send_as_refresh_failed", {
      mailboxId: mailbox.id,
      error: err instanceof Error ? err.name : "unknown",
    });
    return "failed";
  }
}

/** Check 42 P4: the daily refresh, for every mailbox we may read. */
export async function refreshAllSendAs(
  readerFor?: (m: Mailbox) => Pick<MailboxReader, "listSendAs">,
): Promise<number> {
  const rows = await db()
    .select({ mailbox: mailboxes, workspace: workspaces })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(mailboxRunning());
  let ok = 0;
  for (const { mailbox, workspace } of rows) {
    if (!jobsAllowed(workspace)) continue;
    if ((await refreshSendAs(mailbox, readerFor)) === "ok") ok++;
  }
  return ok;
}

/** Check 42 P4: the first read, right after connect (the backfill job). */
export async function refreshSendAsFor(mailboxId: string): Promise<string> {
  const [mailbox] = await db().select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
  if (!mailbox || mailbox.status !== "active") return "skipped";
  return refreshSendAs(mailbox);
}
