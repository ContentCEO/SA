import "server-only";
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { Category } from "@/ai/prompts/classify.v4";
import { db } from "@/db";
import { mailboxes, threads } from "@/db/schema";
import { replyState, type ReplyState } from "./inbox-rules";
import { asDate, customerAddressSql, customerNameSql, lastInSql, lastOutSql } from "./thread-sql";

export type InboxFilter =
  | { kind: "all" }
  | { kind: "needs_me" }
  | { kind: "unsorted" }
  | { kind: "category"; category: Category };

export type InboxRow = {
  id: string;
  subject: string | null;
  summary: string | null;
  category: string | null;
  priority: string | null;
  needsOwner: boolean;
  needsOwnerReason: string | null;
  lastMessageAt: Date | null;
  senderName: string | null;
  senderAddress: string | null;
  extracted: Record<string, unknown> | null;
  /** Leads package: a lead website / voicemail / text-message thread (never drafted). */
  leadChannel: string | null;
  /** "Replied" / "Waiting on you"; null for junk or no customer email. */
  replyState: ReplyState | null;
  /** For "open in Gmail" (Check 40 P2). */
  gmailThreadId: string;
  mailboxEmail: string;
  /** Check 40 P2: what the customer attached, by kind (counts only). */
  attachments: { images: number; pdfs: number; other: number };
};

/** Recent inbox threads for the owner's own mailboxes. Never crosses workspaces. */
export async function listInboxThreads(
  workspaceId: string,
  filter: InboxFilter,
  limit = 100,
): Promise<InboxRow[]> {
  const where: SQL[] = [eq(mailboxes.workspaceId, workspaceId), eq(threads.inInbox, true)];
  if (filter.kind === "needs_me") where.push(eq(threads.needsOwner, true));
  if (filter.kind === "unsorted") where.push(isNull(threads.category));
  if (filter.kind === "category") where.push(eq(threads.category, filter.category));

  const rows = await db()
    .select({
      id: threads.id,
      subject: threads.subject,
      summary: threads.summary,
      category: threads.category,
      priority: threads.priority,
      needsOwner: threads.needsOwner,
      needsOwnerReason: threads.needsOwnerReason,
      lastMessageAt: threads.lastMessageAt,
      extracted: threads.extracted,
      leadChannel: threads.leadChannel,
      // Latest inbound email's customer, as a reply addresses them (a form's Reply-To, else From).
      senderName: customerNameSql(),
      senderAddress: customerAddressSql(),
      lastIn: lastInSql(),
      lastOut: lastOutSql(),
      gmailThreadId: threads.gmailThreadId,
      mailboxEmail: mailboxes.email,
      attImages: sql<number>`(select coalesce(sum(a.attachment_images), 0)::int from messages a where a.thread_id = ${threads.id} and a.direction = 'in' and not a.auto_reply)`,
      attPdfs: sql<number>`(select coalesce(sum(a.attachment_pdfs), 0)::int from messages a where a.thread_id = ${threads.id} and a.direction = 'in' and not a.auto_reply)`,
      attOther: sql<number>`(select coalesce(sum(a.attachment_other), 0)::int from messages a where a.thread_id = ${threads.id} and a.direction = 'in' and not a.auto_reply)`,
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(and(...where))
    .orderBy(desc(threads.needsOwner), desc(threads.lastMessageAt))
    .limit(limit);
  return rows.map(({ lastIn, lastOut, attImages, attPdfs, attOther, ...r }) => ({
    ...r,
    attachments: { images: Number(attImages), pdfs: Number(attPdfs), other: Number(attOther) },
    replyState: replyState({
      lastIn: asDate(lastIn),
      lastOut: asDate(lastOut),
      category: r.category,
      needsOwner: r.needsOwner,
    }),
  }));
}
