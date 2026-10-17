import "server-only";
import { and, desc, eq, gte, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { mailboxes, messages, threads } from "@/db/schema";
import { mailboxRunning } from "./mailbox-plan";
import { STALE_SYNC_MS } from "./mailbox-health";
import {
  NOT_ANSWERED_AFTER_HOURS,
  NOT_ANSWERED_CATEGORIES,
  NOT_ANSWERED_MAX_DAYS,
  NOT_ANSWERED_SHOWN,
} from "./never-answered-rules";
import {
  asDate,
  messageReplyAddress,
  messageReplyName,
  noReplySql,
  waitingReplySql,
  waitingSinceSql,
} from "./thread-sql";

/**
 * Leads package (B6): customers still waiting on a first answer after a day, one row per
 * customer (their reply address, used in SQL only), oldest first, with no card on the queue.
 * Content-free: ids and times. Only mailboxes that are working and synced in the last 30
 * minutes count (a stale mailbox can't see the owner's replies). Lead websites and phone
 * messages are left out (each is its own needs-you card until Done), and so are no-reply
 * senders, building departments, emails that tried to instruct the assistant, finished jobs
 * and decided quotes. "Answered" is the shared rule: an owner email (not a forward to the
 * crew, not an unsent draft) or "I called them" / "Done" (`lastOutSql`), a reply sent from
 * the app since, or one waiting out its undo window.
 */
export async function notAnsweredYet(
  workspaceId: string,
  now: Date,
  excludeThreadIds: ReadonlySet<string>,
  limit = NOT_ANSWERED_SHOWN,
): Promise<{ threadId: string; waitingSince: Date }[]> {
  const waitingSince = waitingSinceSql();
  const replyTo = waitingReplySql();
  const answeredInApp = sql`exists (select 1 from drafts d where d.thread_id = ${threads.id} and (
    (d.status in ('sent', 'edited_and_sent') and d.decided_at >= ${waitingSince})
    or (d.status = 'pending' and (d.send_after is not null or d.send_claimed_at is not null))
  ))`;
  const newest = new Date(now.getTime() - NOT_ANSWERED_AFTER_HOURS * 3_600_000).toISOString();
  const oldest = new Date(now.getTime() - NOT_ANSWERED_MAX_DAYS * 86_400_000).toISOString();
  // One row per customer (where a reply would go, used in SQL only): their oldest wait.
  const ranked = db()
    .select({
      threadId: sql<string>`${threads.id}`.as("thread_id"),
      waitingSince: sql<string | Date | null>`${waitingSince}`.as("waiting_since"),
      rank: sql<number>`row_number() over (partition by ${replyTo} order by ${waitingSince} asc)`.as(
        "rank",
      ),
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        mailboxRunning(),
        gte(mailboxes.lastSyncedAt, new Date(now.getTime() - STALE_SYNC_MS)),
        eq(threads.inInbox, true),
        inArray(threads.category, [...NOT_ANSWERED_CATEGORIES]),
        isNull(threads.leadChannel),
        isNull(threads.quoteOutcome),
        or(isNull(threads.snoozedUntil), lte(threads.snoozedUntil, now)),
        sql`coalesce(${threads.extracted}->>'injection', '') <> 'true'`,
        sql`coalesce(${threads.extracted}->>'municipal', '') <> 'true'`,
        sql`coalesce(${threads.extracted}->>'job_done', '') <> 'true'`,
        sql`${waitingSince} between ${oldest}::timestamptz and ${newest}::timestamptz`,
        sql`not ${noReplySql(replyTo)}`,
        sql`not ${answeredInApp}`,
        // Queue cards are already in front of the owner; one per customer among the rest.
        ...(excludeThreadIds.size ? [notInArray(threads.id, [...excludeThreadIds])] : []),
      ),
    )
    .as("ranked");
  const rows = await db()
    .select({ threadId: ranked.threadId, waitingSince: ranked.waitingSince })
    .from(ranked)
    .where(eq(ranked.rank, 1));
  return rows
    .map((r) => ({ threadId: r.threadId, waitingSince: asDate(r.waitingSince)! }))
    .filter((r) => r.waitingSince)
    .sort((a, b) => a.waitingSince.getTime() - b.waitingSince.getTime())
    .slice(0, limit);
}

export type NotAnsweredRow = {
  threadId: string;
  waitingSince: Date;
  category: string | null;
  summary: string | null;
  extracted: unknown;
  customerName: string | null;
  customerAddress: string | null;
  gmailThreadId: string;
  mailboxEmail: string;
};

/** The rows the queue screen shows under "Not answered yet" (what the owner reads). */
export async function notAnsweredRows(
  workspaceId: string,
  now: Date,
  excludeThreadIds: ReadonlySet<string>,
): Promise<NotAnsweredRow[]> {
  const ids = await notAnsweredYet(workspaceId, now, excludeThreadIds);
  if (!ids.length) return [];
  const rows = await db()
    .select({
      threadId: threads.id,
      category: threads.category,
      summary: threads.summary,
      extracted: threads.extracted,
      gmailThreadId: threads.gmailThreadId,
      mailboxEmail: mailboxes.email,
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        inArray(
          threads.id,
          ids.map((r) => r.threadId),
        ),
      ),
    );
  const people = await db()
    .select({
      threadId: messages.threadId,
      name: messageReplyName(),
      address: messageReplyAddress(),
      sentAt: messages.sentAt,
    })
    .from(messages)
    .where(
      and(
        inArray(
          messages.threadId,
          ids.map((r) => r.threadId),
        ),
        eq(messages.direction, "in"),
      ),
    )
    .orderBy(desc(messages.sentAt));
  const who = new Map<string, { name: string | null; address: string | null }>();
  for (const p of people) if (!who.has(p.threadId)) who.set(p.threadId, p);
  const byId = new Map(rows.map((r) => [r.threadId, r]));
  return ids.flatMap((r) => {
    const t = byId.get(r.threadId);
    if (!t) return [];
    return [
      {
        ...t,
        waitingSince: r.waitingSince,
        customerName: who.get(r.threadId)?.name ?? null,
        customerAddress: who.get(r.threadId)?.address ?? null,
      },
    ];
  });
}
