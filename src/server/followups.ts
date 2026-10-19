import "server-only";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { SAID_SENT_WAIT_DAYS } from "./money-rules";
import { appSettings, businessProfiles, mailboxes, threads, workspaces } from "@/db/schema";
import { jobsAllowed } from "./lifecycle";
import { localParts, usableTimeZone } from "./snooze-rules";
import { mailboxOn } from "./mailbox-plan-rules";
import { mailboxRunning } from "./mailbox-plan";
import { FOLLOWUP_CATEGORIES, followupSettings, MAX_FOLLOWUPS } from "./drafts";
import {
  answeredByPhoneSql,
  ballInTheirCourtSql,
  billOwedByOwnerSql,
  customerAddressSql,
  lastInSql,
  lastOutSql,
  notDraftSql,
  quietSinceSql,
  quoteNotDismissedSql,
  replyAddressSql,
  serviceCallSql,
  sideEmailSql,
} from "./thread-sql";
import { isAway } from "./away";
import {
  chaseTiming,
  FOLLOWUP_MAX_AGE_DAYS,
  FOLLOWUP_SCAN_LOCAL_HOUR,
  quietCutoff,
} from "./followup-rules";

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
 * Check 21 P4: the first To address of the owner's newest email on the thread (lowercased), for
 * a fresh invoice email nobody has replied to yet. Compared in SQL only, never selected.
 */
const freshInvoiceToSql = () =>
  sql`(select lower(trim(o.to_addresses->>0)) from messages o where o.thread_id = ${threads.id} and o.direction = 'out' and ${notDraftSql("o")} order by o.sent_at desc limit 1)`;

/**
 * Check 21 P4: that address has written to this business before (any thread, any of the
 * workspace's mailboxes, by its reply address), before the invoice went out. Never a stranger
 * or a typo. Never NULL.
 */
export const freshInvoiceToKnownSql = (workspaceId: string) =>
  sql`exists (select 1 from messages i join mailboxes mb on mb.id = i.mailbox_id where mb.workspace_id = ${workspaceId} and i.direction = 'in' and ${notDraftSql("i")} and ${replyAddressSql("i")} = ${freshInvoiceToSql()} and i.sent_at < ${lastOutSql()})`;

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
 * - the owner wrote last, or the customer only acknowledged it since ("Thanks, we'll look it
 *   over", Check 21 P1; an automatic reply or bounce never counts), and the quiet started at
 *   least `days` ago (and not ages ago) — from the acknowledgement when there is one;
 * - the owner's email didn't bounce (`extracted.bounced`);
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

  // Check 21 P3: due on the owner's calendar day (`nudgeDueDate`), not N×24 hours later.
  const quietSince = quietCutoff(now, settings.days, settings.timeZone).toISOString();
  const notBefore = new Date(now.getTime() - FOLLOWUP_MAX_AGE_DAYS * 86_400_000).toISOString();
  // Check 38 P4: quotes over the money limit wait `big_quote_days` (SQL twin of `isBigQuote`),
  // and may be chased up to 2 × that + 7 days after the owner's message.
  const bigTiming = chaseTiming(settings.days, settings.bigQuoteDays, true);
  const bigQuietSince = quietCutoff(now, bigTiming.days, settings.timeZone).toISOString();
  const bigNotBefore = new Date(now.getTime() - bigTiming.maxAgeDays * 86_400_000).toISOString();
  const limitCents = settings.thresholdDollars * 100;
  const bigQuote = settings.bigQuoteDays
    ? sql`(${threads.category} is distinct from 'invoice_payment'
        and (${threads.extracted}->>'invoice_thread') is distinct from 'true'
        and (${threads.category} = 'quote_request' or ${threads.quoteRequestedAt} is not null)
        and (case when ${threads.quoteAmountCents} is not null then ${threads.quoteAmountCents} > ${limitCents}
          else exists (select 1 from jsonb_array_elements(case when jsonb_typeof(${threads.extracted}->'dollar_amounts') = 'array' then ${threads.extracted}->'dollar_amounts' else '[]'::jsonb end) da(v)
            where jsonb_typeof(da.v) = 'number' and (da.v::text)::numeric * 100 > ${limitCents}) end))`
    : sql`false`;
  // The shared "who wrote last": an unsent Gmail draft isn't the owner writing, and a lead
  // forwarded to the crew was never quoted, so it gets no "following up on my quote" nudge.
  const lastIn = lastInSql();
  const lastOut = lastOutSql();
  const quietFrom = quietSinceSql();
  const lastDraft = sql`(select max(d.created_at) from drafts d where d.thread_id = ${threads.id})`;
  const sentNudges = sql`(select count(*) from drafts d where d.thread_id = ${threads.id} and d.kind = 'followup' and d.status in ('sent', 'edited_and_sent'))`;
  const pending = sql`exists (select 1 from drafts d where d.thread_id = ${threads.id} and d.status = 'pending')`;
  // SQL twin of `nudgeBlocked` / `purposeSentOn` (drafts.ts) and `isInvoiceThread`.
  // Never NULL (a NULL here would make `not (...)` NULL and hide every purpose note).
  const invoiceThread = sql`(${threads.category} is not distinct from 'invoice_payment' or (${threads.extracted}->>'invoice_thread') is not distinct from 'true')`;
  const purposeSent = sql`exists (select 1 from drafts d where d.thread_id = ${threads.id} and d.purpose is not null and not (d.purpose = 'deposit' and ${invoiceThread}) and d.status in ('sent', 'edited_and_sent'))`;
  const saidPaid = sql`coalesce(${threads.extracted}->>'payment_said', '') = 'paid'`;
  // Check 12 P3: SQL twin of `saidSentBlocksNudge`: "the check is in the mail" holds nudges for
  // SAID_SENT_WAIT_DAYS from that email (never NULL: a bad date reads as no hold).
  const saidSentHold = sql`(coalesce(${threads.extracted}->'invoice'->>'status', '') = 'said_sent'
    and (${threads.extracted}->'invoice'->>'said_sent_at') ~ '^\\d{4}-\\d{2}-\\d{2}T'
    and (${threads.extracted}->'invoice'->>'said_sent_at')::timestamptz > ${new Date(now.getTime() - SAID_SENT_WAIT_DAYS * 86_400_000).toISOString()}::timestamptz)`;
  // Check 21 P5: the customer answered in a NEW email (new subject, same address) after the
  // owner's last message: the old conversation only looks quiet. SQL twin of
  // `customerWroteElsewhere` (drafts.ts). Compared in SQL only; no address is selected. A
  // spouse writing from their own address can't be matched — that's the owner's "I called
  // them" or Discard. A fresh invoice email (no customer email on it) uses its To address.
  const wroteElsewhere = sql`exists (select 1 from messages e join mailboxes eb on eb.id = e.mailbox_id where eb.workspace_id = ${box.workspaceId} and e.thread_id <> ${threads.id} and e.direction = 'in' and ${notDraftSql("e")} and e.auto_reply = false and not ${sideEmailSql("e")} and ${replyAddressSql("e")} = coalesce(${customerAddressSql()}, ${freshInvoiceToSql()}) and e.sent_at > ${lastOut})`;

  const rows = await db()
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.mailboxId, mailboxId),
        // SQL twin of `needsOwnerBlocksNudge` (Check 12 P1): a big invoice is still chased.
        sql`(${threads.needsOwner} = false or ${amountOnlyNeedsOwnerSql()})`,
        // SQL twin of `quoteStopsNudges` (Check 21 P4: any invoice thread, `isInvoiceThread`).
        sql`(${threads.quoteOutcome} is null or (${threads.quoteOutcome} = 'won' and ${invoiceThread}))`,
        isNull(threads.invoicePaidAt),
        // Check 21 P4: a quote or invoice by category, or any invoice thread (an invoice the
        // owner emailed on a conversation last sorted as scheduling).
        sql`(${inArray(threads.category, [...FOLLOWUP_CATEGORIES])} or ${invoiceThread})`,
        // Check 11 P8: the owner said "Not a quote", so no "following up on my quote".
        sql`not (${threads.category} = 'quote_request' and not ${quoteNotDismissedSql()})`,
        // Never chase a bill the owner owes (round 2, TW A2), even when the sorter couldn't
        // tell which way it went but the sender is a supplier (Check 12 P4).
        sql`not ${billOwedByOwnerSql()}`,
        // Someone to nudge: the customer wrote on it and the ball is in their court (Check 21
        // P1: an acknowledgement or auto-reply since the owner wrote doesn't count) — or (Check
        // 21 P4) a fresh invoice email whose To address has written to this mailbox before.
        sql`((${lastIn} is not null and ${ballInTheirCourtSql()}) or (${lastIn} is null and ${threads.ownerInvoiceAt} is not null and ${freshInvoiceToKnownSql(box.workspaceId)}))`,
        // The quiet counts from the owner's last email or the customer's later acknowledgement.
        sql`${quietFrom} < (case when ${bigQuote} then ${bigQuietSince}::timestamptz else ${quietSince}::timestamptz end)`,
        // Check 21 P2: a customer who asked us to wait ("after the holidays") isn't nudged
        // before then, and the 21-day window counts from that date when it's later.
        sql`(${threads.nudgeAfter} is null or ${threads.nudgeAfter} <= ${now.toISOString()}::timestamptz)`,
        sql`greatest(${quietFrom}, ${threads.nudgeAfter}) >= (case when ${bigQuote} then ${bigNotBefore}::timestamptz else ${notBefore}::timestamptz end)`,
        sql`(${threads.extracted}->>'bounced') is distinct from 'true'`,
        sql`${sentNudges} < ${MAX_FOLLOWUPS}`,
        sql`(${lastDraft} is null or ${lastDraft} < ${lastOut})`,
        sql`not ${pending}`,
        sql`not ${purposeSent}`,
        sql`not ${saidPaid}`,
        sql`not ${saidSentHold}`,
        sql`not ${wroteElsewhere}`,
        // Check 36 P3: an emergency answered "On my way" with no price is a service call, not an
        // estimate to check in on. SQL twin of `isServiceCall`; the drafter's check decides.
        sql`not ${serviceCallSql()}`,
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

/** Check 21 P3: `app_settings` key holding the owner's local date of their last scan. */
const scannedKey = (workspaceId: string) => `followup-scan:${workspaceId}`;

/**
 * Check 21 P3: the workspaces whose follow-up scan is due now — the owner's local hour is 4am
 * (`FOLLOWUP_SCAN_LOCAL_HOUR`, their `business_profile.time_zone`, Eastern when unset) and they
 * weren't scanned on that local date yet — with their running mailboxes. Read-only accounts are
 * left out (createDraftForThread would refuse anyway).
 */
export async function followupScanDue(now: Date = new Date()) {
  const rows = await db()
    .select({
      workspaceId: workspaces.id,
      workspace: workspaces,
      timeZone: businessProfiles.timeZone,
      mailboxId: mailboxes.id,
      backfillCompletedAt: mailboxes.backfillCompletedAt,
      scanned: sql<
        string | null
      >`(select s.value from app_settings s where s.key = 'followup-scan:' || ${workspaces.id}::text)`,
    })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .leftJoin(businessProfiles, eq(businessProfiles.workspaceId, workspaces.id))
    .where(mailboxRunning());
  const due = new Map<
    string,
    { workspaceId: string; localDate: string; mailboxes: { id: string; backfillDone: boolean }[] }
  >();
  for (const r of rows) {
    if (!jobsAllowed(r.workspace, now)) continue;
    const local = localParts(now, usableTimeZone(r.timeZone));
    if (local.hour !== FOLLOWUP_SCAN_LOCAL_HOUR || r.scanned === local.date) continue;
    const entry = due.get(r.workspaceId) ?? {
      workspaceId: r.workspaceId,
      localDate: local.date,
      mailboxes: [],
    };
    entry.mailboxes.push({ id: r.mailboxId, backfillDone: r.backfillCompletedAt != null });
    due.set(r.workspaceId, entry);
  }
  return [...due.values()];
}

/** Check 21 P3: the scan for this owner's local date is done; a retry the same day is a no-op. */
export async function markFollowupScanned(workspaceId: string, localDate: string) {
  await db()
    .insert(appSettings)
    .values({ key: scannedKey(workspaceId), value: localDate, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: localDate, updatedAt: new Date() },
    });
}
