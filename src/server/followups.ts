import "server-only";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { mailboxes, threads } from "@/db/schema";
import { FOLLOWUP_CATEGORIES, followupSettings, MAX_FOLLOWUPS } from "./drafts";
import { lastInSql, lastOutSql } from "./thread-sql";

/** Don't chase anything the owner last wrote about more than this long ago. */
export const FOLLOWUP_MAX_AGE_DAYS = 21;

/**
 * Threads due a nudge, for the daily scan:
 * - a quote or invoice thread that isn't flagged for the owner;
 * - not a decided quote: lost / no answer (the owner's or our guess) stops every nudge,
 *   won stops the quote nudges but a won job's invoice is still chased (quoteStopsNudges);
 * - not a paid invoice: marked paid (the owner's mark or our guess) or "not owed to me"
 *   is never chased (plan #27);
 * - no deposit, review request or closing question was ever sent on it (A3): the customer
 *   accepted, was thanked, or was already asked once — a deposit only while it's a quote:
 *   once the thread is about an invoice, the won job's invoice is still chased;
 * - the customer's newest email didn't say they paid (`payment_said`);
 * - the owner wrote last, at least `days` ago (and not ages ago);
 * - the customer has written at least once (someone to nudge);
 * - fewer than two nudges sent, ever;
 * - no draft of any kind since the owner's last message — so a nudge the
 *   owner discarded isn't written again until they write again — and none pending.
 */
export async function threadsToFollowUp(
  mailboxId: string,
  now: Date = new Date(),
  limit = 20,
): Promise<string[]> {
  const [box] = await db()
    .select({ workspaceId: mailboxes.workspaceId })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId));
  if (!box) return [];
  const settings = await followupSettings(box.workspaceId);
  if (!settings.enabled) return [];

  const quietSince = new Date(now.getTime() - settings.days * 86_400_000).toISOString();
  const notBefore = new Date(now.getTime() - FOLLOWUP_MAX_AGE_DAYS * 86_400_000).toISOString();
  // The shared "who wrote last": an unsent Gmail draft isn't the owner writing, and a lead
  // forwarded to the crew was never quoted, so it gets no "following up on my quote" nudge.
  const lastIn = lastInSql();
  const lastOut = lastOutSql();
  const lastDraft = sql`(select max(d.created_at) from drafts d where d.thread_id = ${threads.id})`;
  const sentNudges = sql`(select count(*) from drafts d where d.thread_id = ${threads.id} and d.kind = 'followup' and d.status in ('sent', 'edited_and_sent'))`;
  const pending = sql`exists (select 1 from drafts d where d.thread_id = ${threads.id} and d.status = 'pending')`;
  // SQL twin of `nudgeBlocked` / `purposeSentOn` (drafts.ts) and `isInvoiceThread`.
  // Never NULL (a NULL here would make `not (...)` NULL and hide every purpose note).
  const invoiceThread = sql`(${threads.category} is not distinct from 'invoice_payment' or (${threads.extracted}->>'invoice_thread') is not distinct from 'true')`;
  const purposeSent = sql`exists (select 1 from drafts d where d.thread_id = ${threads.id} and d.purpose is not null and not (d.purpose = 'deposit' and ${invoiceThread}) and d.status in ('sent', 'edited_and_sent'))`;
  const saidPaid = sql`coalesce(${threads.extracted}->>'payment_said', '') = 'paid'`;

  const rows = await db()
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.mailboxId, mailboxId),
        eq(threads.needsOwner, false),
        // SQL twin of `quoteStopsNudges`.
        sql`(${threads.quoteOutcome} is null or (${threads.quoteOutcome} = 'won' and ${threads.category} = 'invoice_payment'))`,
        isNull(threads.invoicePaidAt),
        inArray(threads.category, [...FOLLOWUP_CATEGORIES]),
        sql`${lastIn} is not null`,
        sql`${lastOut} > ${lastIn}`,
        sql`${lastOut} <= ${quietSince}::timestamptz`,
        sql`${lastOut} >= ${notBefore}::timestamptz`,
        sql`${sentNudges} < ${MAX_FOLLOWUPS}`,
        sql`(${lastDraft} is null or ${lastDraft} < ${lastOut})`,
        sql`not ${pending}`,
        sql`not ${purposeSent}`,
        sql`not ${saidPaid}`,
      ),
    )
    .orderBy(desc(threads.lastMessageAt))
    .limit(limit);
  return rows.map((r) => r.id);
}
