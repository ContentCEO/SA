import "server-only";
import { and, count, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
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
  /** Check 10 P6: for "Open in Gmail" (the owner's own mailbox, as on Queue and Quotes). */
  gmailThreadId: string;
  mailboxEmail: string;
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
  /**
   * Check 10 P4: the draft waiting in the Queue for this thread (pending, not already in its
   * undo window or being sent), or null.
   */
  pendingDraftId: string | null;
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

/** Check 10 P2: where the next page starts — the last row shown (content-free, in the URL). */
export type InboxCursor = { afterId: string; before: Date | null };

/** Check 10 P2: rows shown on All apart from folded junk, and the junk itself. */
type JunkPart = "all" | "no_junk" | "only_junk";

const junkSql = () => sql`(${threads.category} = 'noise' and not ${openNeedsOwnerSql()})`;
const timeKey = () => sql`coalesce(${threads.lastMessageAt}, '-infinity'::timestamptz)`;

/** Recent inbox threads for the owner's own mailboxes. Never crosses workspaces. */
export async function listInboxThreads(
  workspaceId: string,
  filter: InboxFilter,
  opts: { limit?: number; now?: Date; cursor?: InboxCursor | null; junk?: JunkPart } = {},
): Promise<InboxRow[]> {
  const limit = opts.limit ?? 100;
  const now = opts.now ?? new Date();
  const where: SQL[] = [eq(mailboxes.workspaceId, workspaceId), eq(threads.inInbox, true)];
  // Check 10 P1: "needs me" is the open rule (answered from Gmail or by phone lets go).
  if (filter.kind === "needs_me") where.push(openNeedsOwnerSql());
  if (filter.kind === "unsorted") where.push(isNull(threads.category));
  if (filter.kind === "category") where.push(eq(threads.category, filter.category));
  if (opts.junk === "no_junk") where.push(sql`not ${junkSql()}`);
  if (opts.junk === "only_junk") where.push(junkSql());

  // Check 10 P2: keyset paging in the same order. The anchor is the last row of the previous
  // page, looked up in THIS workspace (an id from elsewhere finds nothing and falls back to
  // the time in the URL), so a cursor never crosses workspaces.
  if (opts.cursor) {
    const [anchor] = await db()
      .select({ tier: tierSql(now), at: sql<string>`${timeKey()}::text` })
      .from(threads)
      .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
      .where(and(eq(threads.id, opts.cursor.afterId), eq(mailboxes.workspaceId, workspaceId)));
    const at = anchor
      ? sql`${anchor.at}::timestamptz`
      : opts.cursor.before
        ? sql`${opts.cursor.before.toISOString()}::timestamptz`
        : sql`'-infinity'::timestamptz`;
    where.push(
      sql`(${tierSql(now)}, ${timeKey()}, ${threads.id}) < (${anchor ? Number(anchor.tier) : 0}, ${at}, ${opts.cursor.afterId}::uuid)`,
    );
  }

  const rows = await db()
    .select({
      id: threads.id,
      gmailThreadId: threads.gmailThreadId,
      mailboxEmail: mailboxes.email,
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
      pendingDraftId: sql<
        string | null
      >`(select d.id from drafts d where d.thread_id = ${threads.id} and d.status = 'pending' and d.send_after is null and d.send_claimed_at is null order by d.created_at desc limit 1)`,
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(and(...where))
    // Check 10 P3: emergencies today first, then needs you, then urgent today, then newest
    // (no time sorts last), then id so ties are stable.
    .orderBy(desc(tierSql(now)), desc(timeKey()), desc(threads.id))
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

export const INBOX_PAGE_SIZE = 100;
export const INBOX_JUNK_SHOWN = 50;

export type InboxPage = {
  rows: InboxRow[];
  /** On All: folded junk (count, and the newest few for the folded line). */
  junk: { count: number; rows: InboxRow[] };
  /** Where "Show older emails" goes; null on the last page. */
  next: InboxCursor | null;
};

/**
 * Check 10 P2: one page of the Inbox. On All, junk doesn't take real rows' places: the page is
 * up to 100 non-junk rows, and junk is a count plus the 50 newest (first page only).
 */
export async function inboxPage(
  workspaceId: string,
  filter: InboxFilter,
  opts: { now?: Date; cursor?: InboxCursor | null; pageSize?: number } = {},
): Promise<InboxPage> {
  const now = opts.now ?? new Date();
  const size = opts.pageSize ?? INBOX_PAGE_SIZE;
  const fold = filter.kind === "all";
  const fetched = await listInboxThreads(workspaceId, filter, {
    now,
    cursor: opts.cursor,
    limit: size + 1,
    junk: fold ? "no_junk" : "all",
  });
  const rows = fetched.slice(0, size);
  const last = rows.at(-1);
  const next =
    fetched.length > size && last ? { afterId: last.id, before: last.lastMessageAt } : null;
  if (!fold || opts.cursor) return { rows, junk: { count: 0, rows: [] }, next };
  const [junkRows, [counted]] = await Promise.all([
    listInboxThreads(workspaceId, filter, { now, limit: INBOX_JUNK_SHOWN, junk: "only_junk" }),
    db()
      .select({ n: count() })
      .from(threads)
      .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
      .where(and(eq(mailboxes.workspaceId, workspaceId), eq(threads.inInbox, true), junkSql())),
  ]);
  return { rows, junk: { count: Number(counted?.n ?? 0), rows: junkRows }, next };
}
