import "server-only";
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { Category } from "@/ai/prompts/classify.v1";
import { db } from "@/db";
import { mailboxes, threads } from "@/db/schema";

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

  return db()
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
      // Latest inbound sender on the thread.
      senderName: sql<
        string | null
      >`(select m.from_name from messages m where m.thread_id = ${threads.id} and m.direction = 'in' order by m.sent_at desc limit 1)`,
      senderAddress: sql<
        string | null
      >`(select m.from_address from messages m where m.thread_id = ${threads.id} and m.direction = 'in' order by m.sent_at desc limit 1)`,
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(and(...where))
    .orderBy(desc(threads.needsOwner), desc(threads.lastMessageAt))
    .limit(limit);
}
