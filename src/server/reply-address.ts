import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { mailboxes, messages } from "@/db/schema";
import type { MailboxReader } from "@/mailbox/connector";
import { pickReplyTo, type ReplyToHeader } from "./reply-address-rules";

/**
 * Reading a stored email's Reply-To from Gmail after the fact (review "Must fix", B1): for
 * rows stored before sync read it. Used by the draft path (just before a draft is written)
 * and by the one-shot backfill. Never logs an address.
 */

/** Every mailbox address of a workspace, lowercased: a Reply-To to any of them is no customer. */
export async function workspaceMailboxEmails(workspaceId: string): Promise<string[]> {
  const rows = await db()
    .select({ email: mailboxes.email })
    .from(mailboxes)
    .where(eq(mailboxes.workspaceId, workspaceId));
  return rows.map((r) => r.email.trim().toLowerCase());
}

/**
 * Ask Gmail for one stored message's Reply-To only (format=metadata) and store the choice,
 * unless something else stored one first. A message Gmail no longer has (404) is stored as
 * {} — From is all there is. Throws whatever the reader throws otherwise (auth, rate limit):
 * callers decide; nothing is stored then.
 */
export async function readReplyTo(
  reader: Pick<MailboxReader, "getMessage">,
  row: { id: string; gmailMessageId: string; fromAddress: string | null },
  self: readonly string[],
): Promise<ReplyToHeader> {
  const m = await reader.getMessage(row.gmailMessageId, {
    withBody: false,
    headers: ["Reply-To"],
  });
  const picked: ReplyToHeader = m
    ? pickReplyTo(m.headers.replyTo, { from: row.fromAddress, self })
    : {};
  return storeReplyTo(row.id, picked);
}

/** Store a choice on a row that has none yet; returns what is stored now. */
export async function storeReplyTo(messageId: string, picked: ReplyToHeader) {
  const [done] = await db()
    .update(messages)
    .set({ replyToHeader: picked })
    .where(and(eq(messages.id, messageId), isNull(messages.replyToHeader)))
    .returning({ replyToHeader: messages.replyToHeader });
  if (done) return done.replyToHeader ?? picked;
  const [now] = await db()
    .select({ replyToHeader: messages.replyToHeader })
    .from(messages)
    .where(eq(messages.id, messageId));
  return now?.replyToHeader ?? picked;
}
