import "server-only";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { mailboxes, threads } from "@/db/schema";
import { mailboxOn } from "./mailbox-plan-rules";
import { FOLLOWUP_CATEGORIES, followupSettings, MAX_FOLLOWUPS } from "./drafts";
import { lastInSql, lastOutSql, answeredByPhoneSql } from "./thread-sql";
import { isAway } from "./away";
import { FOLLOWUP_MAX_AGE_DAYS } from "./followup-rules";

/**
 * SQL twin of `amountOnlyNeedsOwner` (followup-rules.ts): an invoice thread whose only owner
 * rules are the money limit (and the model's own flag), with no manual, complaint, dispute,
 * attack, payment-change or "is this a bot" mark. Never NULL.
 */
export function amountOnlyNeedsOwnerSql() {
  const x = threads.extracted;
  return sql`(${threads.needsOwnerManual} = false
    and ${threads.category} is not distinct from 'invoice_payment'
    and ${threads.complainedAt} is null
    and coalesce(${x}->>'disputed', '') <> 'true'
    and coalesce(${x}->>'injection', '') <> 'true'
    and coalesce(${x}->>'payment_change', '') <> 'true'
    and coalesce(${x}->>'asks_if_ai', '') <> 'true'
    and jsonb_typeof(${x}->'owner_rule_hits') = 'array'
    and (${x}->'owner_rule_hits') @> '["amount"]'::jsonb
    and not exists (
      select 1 from jsonb_array_elements_text(${x}->'owner_rule_hits') h(v)
      where h.v not in ('amount', 'model')
    ))`;
}

export { FOLLOWUP_MAX_AGE_DAYS };

/**
 * Threads due a nudge, for the daily scan:
 * - a quote or invoice thread that isn't flagged for the owner (an invoice flagged only for
 *   its size is still chased, Check 12 P1);
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
    .select({
      workspaceId: mailboxes.workspaceId,
      status: mailboxes.status,
      planPausedAt: mailboxes.planPausedAt,
    })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId));
  // Lost access or paused on the plan (2026-10-16): no nudges (createDraftForThread agrees).
  if (!box || !mailboxOn(box)) return [];
  const settings = await followupSettings(box.workspaceId);
  if (!settings.enabled) return [];
  // Ideas E7: nudges pause while the owner is away (createDraftForThread checks it again).
  if (await isAway(box.workspaceId, now)) return [];

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
        // SQL twin of `needsOwnerBlocksNudge` (Check 12 P1): a big invoice is still chased.
        sql`(${threads.needsOwner} = false or ${amountOnlyNeedsOwnerSql()})`,
        // SQL twin of `quoteStopsNudges`.
        sql`(${threads.quoteOutcome} is null or (${threads.quoteOutcome} = 'won' and ${threads.category} = 'invoice_payment'))`,
        isNull(threads.invoicePaidAt),
        inArray(threads.category, [...FOLLOWUP_CATEGORIES]),
        // Never chase a bill the owner owes (round 2, TW A2).
        sql`(${threads.extracted}->>'bill_direction') is distinct from 'owed_by_business'`,
        sql`${lastIn} is not null`,
        sql`${lastOut} > ${lastIn}`,
        sql`${lastOut} <= ${quietSince}::timestamptz`,
        // Check 21 P2: a customer who asked us to wait ("after the holidays") isn't nudged
        // before then, and the 21-day window counts from that date when it's later.
        sql`(${threads.nudgeAfter} is null or ${threads.nudgeAfter} <= ${now.toISOString()}::timestamptz)`,
        sql`greatest(${lastOut}, ${threads.nudgeAfter}) >= ${notBefore}::timestamptz`,
        sql`${sentNudges} < ${MAX_FOLLOWUPS}`,
        sql`(${lastDraft} is null or ${lastDraft} < ${lastOut})`,
        sql`not ${pending}`,
        sql`not ${purposeSent}`,
        sql`not ${saidPaid}`,
        // "I called them" (round 2, FW E11): the call answered it, so no nudge.
        sql`not ${answeredByPhoneSql()}`,
        // Ideas H3: sorted under the owner's "Never draft" rule.
        sql`(${threads.extracted}->>'sender_rule') is distinct from 'no_draft'`,
      ),
    )
    .orderBy(desc(threads.lastMessageAt))
    .limit(limit);
  return rows.map((r) => r.id);
}
