import "server-only";
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { Category } from "@/ai/prompts/classify.v4";
import { db } from "@/db";
import { mailboxes, threads } from "@/db/schema";
import { INBOX_URGENT_WINDOW_MS, replyState, type ReplyState } from "./inbox-rules";
import { openNeedsOwnerSql } from "./needs-owner";
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
  /** Check 10 P3: the sorter's `extracted.urgency` (emergency / high / normal / low). */
  urgency: string | null;
  /** Check 10 P1: open needs-you (flagged and the owner hasn't answered since). */
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
};

/**
 * Check 10 P3: the Inbox's tier in SQL, the twin of `inboxTier` (inbox-rules.ts): an emergency
 * from the last 24 hours the customer wrote last on (4), open needs-you (2), urgent from the
 * last 24 hours (1), added together.
 */
function tierSql(now: Date) {
  const cut = sql`${new Date(now.getTime() - INBOX_URGENT_WINDOW_MS).toISOString()}::timestamptz`;
  const recent = sql`coalesce(${threads.lastMessageAt} > ${cut}, false)`;
  const waiting = sql`(${lastInSql()} is not null and (${lastOutSql()} is null or ${lastOutSql()} < ${lastInSql()}))`;
  return sql<number>`((case when ${threads.extracted}->>'urgency' = 'emergency' and ${recent} and ${waiting} then 4 else 0 end) + (case when ${openNeedsOwnerSql()} then 2 else 0 end) + (case when ${threads.priority} = 'high' and ${recent} then 1 else 0 end))`;
}

/** Recent inbox threads for the owner's own mailboxes. Never crosses workspaces. */
export async function listInboxThreads(
  workspaceId: string,
  filter: InboxFilter,
  opts: { limit?: number; now?: Date } = {},
): Promise<InboxRow[]> {
  const limit = opts.limit ?? 100;
  const now = opts.now ?? new Date();
  const where: SQL[] = [eq(mailboxes.workspaceId, workspaceId), eq(threads.inInbox, true)];
  // Check 10 P1: "needs me" is the open rule (answered from Gmail or by phone lets go).
  if (filter.kind === "needs_me") where.push(openNeedsOwnerSql());
  if (filter.kind === "unsorted") where.push(isNull(threads.category));
  if (filter.kind === "category") where.push(eq(threads.category, filter.category));

  const rows = await db()
    .select({
      id: threads.id,
      subject: threads.subject,
      summary: threads.summary,
      category: threads.category,
      priority: threads.priority,
      urgency: sql<string | null>`${threads.extracted}->>'urgency'`,
      // Check 10 P1: flagged AND not answered since (a reply or a call), never the raw column.
      needsOwner: openNeedsOwnerSql(),
      needsOwnerReason: threads.needsOwnerReason,
      lastMessageAt: threads.lastMessageAt,
      extracted: threads.extracted,
      leadChannel: threads.leadChannel,
      // Latest inbound email's customer, as a reply addresses them (a form's Reply-To, else From).
      senderName: customerNameSql(),
      senderAddress: customerAddressSql(),
      lastIn: lastInSql(),
      lastOut: lastOutSql(),
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(and(...where))
    // Check 10 P3: emergencies today first, then needs you, then urgent today, then newest
    // (no time sorts last), then id so ties are stable.
    .orderBy(
      desc(tierSql(now)),
      desc(sql`coalesce(${threads.lastMessageAt}, '-infinity'::timestamptz)`),
      desc(threads.id),
    )
    .limit(limit);
  return rows.map(({ lastIn, lastOut, ...r }) => ({
    ...r,
    replyState: replyState({
      lastIn: asDate(lastIn),
      lastOut: asDate(lastOut),
      category: r.category,
      needsOwner: r.needsOwner,
    }),
  }));
}
