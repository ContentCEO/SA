import "server-only";
import { and, count, eq, gte, inArray, isNotNull, isNull, lte, min, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  activityLog,
  appSettings,
  businessProfiles,
  drafts,
  mailboxes,
  messages,
  threads,
  users,
  voiceProfiles,
  workspaces,
  type Workspace,
} from "@/db/schema";
import { appUrl } from "@/lib/app-url";
import { brandEmail } from "@/lib/email-layout";
import { sendEmail, type EmailSender } from "@/lib/email";
import { pushConfigured, sendPush, type PushSender } from "@/lib/web-push";
import { STOP_TRIAL_EMAILS_LABEL } from "./trial-email-rules";
import { stopHeaders, stopLinkFor } from "./trial-email-links";
import { CLASSIFY_LOOKBACK_DAYS } from "./classification";
import {
  createDraftForThread,
  expirePendingDraft,
  followupSettings,
  queueCounts,
  type DraftDeps,
} from "./drafts";
import {
  firstDraftsEmailCopy,
  FOUND_MONEY_MAX,
  NEW_ACCOUNT_DAYS,
  showFirstLook,
  type FirstLookCounts,
} from "./first-week-rules";
import { effectiveStatus, isReadOnly, jobsAllowed, ReadOnlyError } from "./lifecycle";
import { clearNeedsOwnerNow } from "./needs-owner";
import { pushEndpointsByWorkspace, removePushSubscription } from "./push-alerts";
import {
  answeredByPhoneSql,
  crewThreadSql,
  lastInSql,
  lastOutSql,
  waitingSinceSql,
} from "./thread-sql";

/**
 * Round 2, "First week" review (FW): the new owner's first days. Counts and ids only; nothing
 * here reads or logs an email's text, a name or an address.
 */

/** A Date for raw SQL: postgres.js can't bind a Date inside a sql`` template (A10). */
const at = (d: Date) => sql`${d.toISOString()}::timestamptz`;

// ---------------------------------------------------------------------------------------------
// FW E11 "I called them"

/**
 * The owner answered this one by phone. Marks the thread (it counts as answered until the
 * customer writes again: no auto draft, no nudge, off "Needs you", counted by the scorecard)
 * and takes away whatever draft is waiting, here and in Gmail. A reply already tapped Send is
 * left alone. Content-free log.
 */
export async function markAnsweredByPhone(
  workspaceId: string,
  threadId: string,
  opts: DraftDeps = {},
  /**
   * Check 11 P8: Quotes' "I sent the price another way" (estimate software emails the customer
   * itself): the same mark, logged with `via: "other"`, plus the price the owner typed.
   */
  other: { via: "other"; amountCents?: number | null } | null = null,
): Promise<"marked" | "not_found"> {
  const now = opts.now?.() ?? new Date();
  const [row] = await db()
    .select({ threadId: threads.id, workspace: workspaces })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(and(eq(threads.id, threadId), eq(mailboxes.workspaceId, workspaceId)));
  if (!row) return "not_found";
  if (isReadOnly(row.workspace, now)) throw new ReadOnlyError(effectiveStatus(row.workspace, now));
  const typed = other?.amountCents != null;
  await db()
    .update(threads)
    .set({
      handledOfflineAt: now,
      // A typed price is the owner's (Check 11 P3): never replaced by a price read from mail,
      // never in price memory, and it went out now.
      ...(typed
        ? {
            quoteAmountCents: other!.amountCents,
            quoteAmountFrom: "owner" as const,
            quoteAmountNote: null,
            quoteAmountAt: now,
          }
        : {}),
    })
    .where(eq(threads.id, threadId));
  // Check 10 P1: the call answered it, so "Needs you" lets go too (Inbox, Queue, follow-ups).
  await clearNeedsOwnerNow(workspaceId, threadId, "phone");
  const draftRemoved = await expirePendingDraft(threadId, "Answered by phone.", {
    ...opts,
    now: () => now,
  });
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: "owner",
      action: "answered_by_phone",
      threadId,
      // `amountTyped` (yes/no, never the amount) keeps a typed price out of price memory, like a
      // typed Won amount.
      detail: other
        ? { draftRemoved, via: other.via, ...(typed ? { amountTyped: true } : {}) }
        : { draftRemoved },
    });
  return "marked";
}

// ---------------------------------------------------------------------------------------------
// FW D1/D2 "your last 30 days" and found money

const QUOTE = "quote_request";

/** When this workspace's inbox was first read (the earliest finished 30-day backfill). */
async function firstReadAt(workspaceId: string): Promise<Date | null> {
  const [r] = await db()
    .select({ at: min(mailboxes.backfillCompletedAt) })
    .from(mailboxes)
    .where(eq(mailboxes.workspaceId, workspaceId));
  return r?.at ? new Date(r.at) : null;
}

/** Quote threads in this workspace's inbox with no outcome and no draft waiting. */
function openQuoteWhere(boxIds: string[], since: Date) {
  return and(
    inArray(threads.mailboxId, boxIds),
    eq(threads.category, QUOTE),
    isNull(threads.quoteOutcome),
    gte(threads.lastMessageAt, since),
    sql`not exists (select 1 from drafts d where d.thread_id = ${threads.id} and d.status = 'pending')`,
    // One tap drafts several at once, so never the ones only a deliberate, one-at-a-time tap
    // should draft: an attempt to instruct the assistant, a payment change, a town office.
    sql`coalesce(${threads.extracted}->>'injection', '') <> 'true'`,
    sql`coalesce(${threads.extracted}->>'payment_change', '') <> 'true'`,
    sql`coalesce(${threads.extracted}->>'municipal', '') <> 'true'`,
    // Check 41 P6: never the owner's own crew.
    sql`not ${crewThreadSql(sql`(select fw_mb.workspace_id from mailboxes fw_mb where fw_mb.id = ${threads.mailboxId})`)}`,
  );
}

/**
 * The thread ids behind found money (FW D2): quote requests from the sorted window where the
 * customer wrote last (`waitingSinceSql`: a phone call counts as an answer), and quotes the
 * owner answered that went quiet for the follow-up wait with no nudge sent yet. Newest first.
 */
async function foundMoneyIds(workspaceId: string, boxIds: string[], now: Date) {
  if (!boxIds.length) return { replies: [] as string[], nudges: [] as string[] };
  const sortedSince = new Date(now.getTime() - CLASSIFY_LOOKBACK_DAYS * 86_400_000);
  const replies = await db()
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        openQuoteWhere(boxIds, sortedSince),
        eq(threads.inInbox, true),
        sql`${waitingSinceSql()} is not null`,
      ),
    )
    .orderBy(sql`${threads.lastMessageAt} desc`)
    .limit(FOUND_MONEY_MAX);
  const { days } = await followupSettings(workspaceId);
  const quietSince = new Date(now.getTime() - days * 86_400_000);
  const readSince = new Date(now.getTime() - 30 * 86_400_000);
  const nudges = await db()
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        openQuoteWhere(boxIds, readSince),
        eq(threads.needsOwner, false),
        isNull(threads.invoicePaidAt),
        sql`${lastInSql()} is not null`,
        sql`${lastOutSql()} > ${lastInSql()}`,
        sql`${lastOutSql()} <= ${at(quietSince)}`,
        sql`not ${answeredByPhoneSql()}`,
        sql`not exists (select 1 from drafts d where d.thread_id = ${threads.id} and d.kind = 'followup' and d.status in ('sent', 'edited_and_sent'))`,
      ),
    )
    .orderBy(sql`${threads.lastMessageAt} desc`)
    .limit(FOUND_MONEY_MAX);
  return { replies: replies.map((r) => r.id), nudges: nudges.map((r) => r.id) };
}

const foundMoneyKey = (workspaceId: string) => `found-money-drafted:${workspaceId}`;

export type FirstLook = {
  show: boolean;
  counts: FirstLookCounts;
  /** Found money can still be offered (not tapped yet, and there is some). */
  offerDrafts: boolean;
};

/**
 * FW D1/D2: the numbers for the "your last 30 days" card. Counts only. `read` is frozen to the
 * 30 days before the first read; the sorted numbers cover the last two weeks (what the first
 * pass sends to the AI).
 */
export async function firstLookFor(
  workspace: Workspace,
  now: Date = new Date(),
): Promise<FirstLook> {
  const empty: FirstLookCounts = {
    read: 0,
    sorted: 0,
    quoteRequests: 0,
    unansweredQuotes: 0,
    invoices: 0,
    complaints: 0,
    junk: 0,
    quietQuotes: 0,
  };
  const readAt = await firstReadAt(workspace.id);
  const [profile] = await db()
    .select({ hiddenAt: businessProfiles.firstLookHiddenAt })
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspace.id));
  const show = showFirstLook({
    firstReadAt: readAt,
    hiddenAt: profile?.hiddenAt ?? null,
    readOnly: isReadOnly(workspace, now),
    now,
    accountCreatedAt: workspace.createdAt,
  });
  if (!show || !readAt) return { show: false, counts: empty, offerDrafts: false };
  return { show: true, ...(await firstLookCounts(workspace.id, readAt, now)) };
}

/** The counts themselves (also shown on the learning screen once reading is done). */
export async function firstLookCounts(
  workspaceId: string,
  readAt: Date,
  now: Date = new Date(),
): Promise<{ counts: FirstLookCounts; offerDrafts: boolean }> {
  const boxIds = (
    await db()
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.workspaceId, workspaceId))
  ).map((b) => b.id);
  if (!boxIds.length) {
    return {
      counts: {
        read: 0,
        sorted: 0,
        quoteRequests: 0,
        unansweredQuotes: 0,
        invoices: 0,
        complaints: 0,
        junk: 0,
        quietQuotes: 0,
      },
      offerDrafts: false,
    };
  }
  const windowStart = new Date(readAt.getTime() - 30 * 86_400_000);
  const [read] = await db()
    .select({ n: count() })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(
      and(
        inArray(threads.mailboxId, boxIds),
        gte(messages.sentAt, windowStart),
        lte(messages.sentAt, readAt),
      ),
    );
  const sortedSince = new Date(now.getTime() - CLASSIFY_LOOKBACK_DAYS * 86_400_000);
  const byCategory = await db()
    .select({ category: threads.category, n: count() })
    .from(threads)
    .where(
      and(
        inArray(threads.mailboxId, boxIds),
        isNotNull(threads.classifiedAt),
        isNotNull(threads.category),
        gte(threads.lastMessageAt, sortedSince),
      ),
    )
    .groupBy(threads.category);
  const of = (c: string) => byCategory.find((r) => r.category === c)?.n ?? 0;
  const found = await foundMoneyIds(workspaceId, boxIds, now);
  const [tapped] = await db()
    .select({ key: appSettings.key })
    .from(appSettings)
    .where(eq(appSettings.key, foundMoneyKey(workspaceId)));
  return {
    counts: {
      read: read?.n ?? 0,
      sorted: byCategory.reduce((sum, r) => sum + r.n, 0),
      quoteRequests: of(QUOTE),
      unansweredQuotes: found.replies.length,
      invoices: of("invoice_payment"),
      complaints: of("complaint"),
      junk: of("noise"),
      quietQuotes: found.nudges.length,
    },
    offerDrafts: !tapped && found.replies.length + found.nudges.length > 0,
  };
}

/** The owner hid the card. */
export async function hideFirstLook(workspaceId: string, now: Date = new Date()) {
  await db()
    .insert(businessProfiles)
    .values({ workspaceId, firstLookHiddenAt: now })
    .onConflictDoUpdate({
      target: businessProfiles.workspaceId,
      set: { firstLookHiddenAt: now },
    });
}

/**
 * FW D2, the owner's tap: which threads to draft for, worked out again now (never from the
 * screen). Offered once: the marker hides the offer whatever happens next. Read-only accounts
 * get nothing (`ReadOnlyError`).
 */
export async function claimFoundMoneyDrafts(
  workspace: Workspace,
  now: Date = new Date(),
): Promise<{ replies: string[]; nudges: string[] } | null> {
  if (isReadOnly(workspace, now)) throw new ReadOnlyError(effectiveStatus(workspace, now));
  const [claimed] = await db()
    .insert(appSettings)
    .values({ key: foundMoneyKey(workspace.id), value: now.toISOString() })
    .onConflictDoNothing()
    .returning({ key: appSettings.key });
  if (!claimed) return null;
  const boxIds = (
    await db()
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.workspaceId, workspace.id))
  ).map((b) => b.id);
  const found = await foundMoneyIds(workspace.id, boxIds, now);
  await db()
    .insert(activityLog)
    .values({
      workspaceId: workspace.id,
      actor: "owner",
      action: "found_money_drafts_requested",
      detail: { replies: found.replies.length, nudges: found.nudges.length },
    });
  return found;
}

/**
 * The job behind that tap: one draft per thread, on the owner's say-so. Replies go through the
 * owner's own "Draft a reply" path; nudges through the follow-up path, which re-checks the cap
 * and the category. Every one is a draft in the queue; nothing is sent.
 */
export async function draftFoundMoneyThread(
  workspaceId: string,
  threadId: string,
  kind: "reply" | "nudge",
) {
  if (kind === "reply") return createDraftForThread(threadId, { trigger: "owner", workspaceId });
  // The follow-up path doesn't take a workspace: check the thread is this owner's first.
  const [own] = await db()
    .select({ id: threads.id })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(and(eq(threads.id, threadId), eq(mailboxes.workspaceId, workspaceId)));
  if (!own) return { status: "skipped" as const, reason: "not_found" as const };
  return createDraftForThread(threadId, { trigger: "followup" });
}

// ---------------------------------------------------------------------------------------------
// FW D4 "your first drafts are ready"

/** Only for inboxes first read this recently, so accounts from before this never get one. */
export const FIRST_DRAFTS_WINDOW_MS = 3 * 86_400_000;
const firstDraftsKey = (workspaceId: string) => `first-drafts-ready:${workspaceId}`;

/**
 * Every 15 minutes (and after drafting): once ever per workspace, when its inbox has been read,
 * the voice learning is done and at least one draft waits, email the owner (and buzz any phone
 * that allowed notifications) that the first drafts are ready to check. Counts only. Marked
 * once something reached them; without Resend and push nothing is marked, so it can go later.
 */
export async function sendFirstDraftsReady(
  now: Date = new Date(),
  deps: { send?: EmailSender; push?: PushSender; workspaceId?: string } = {},
) {
  const send = deps.send ?? sendEmail;
  const push = deps.push ?? (pushConfigured() ? sendPush : null);
  const since = new Date(now.getTime() - FIRST_DRAFTS_WINDOW_MS);
  const rows = await db()
    .select({ workspace: workspaces, ownerEmail: users.email })
    .from(workspaces)
    .innerJoin(users, eq(users.id, workspaces.ownerUserId))
    .innerJoin(voiceProfiles, eq(voiceProfiles.workspaceId, workspaces.id))
    .where(
      and(
        deps.workspaceId ? eq(workspaces.id, deps.workspaceId) : undefined,
        ne(voiceProfiles.status, "learning"),
        // A first week only: an old account whose Gmail is read again after a reconnect gets none.
        gte(workspaces.createdAt, new Date(now.getTime() - NEW_ACCOUNT_DAYS * 86_400_000)),
        sql`exists (select 1 from mailboxes b where b.workspace_id = ${workspaces.id} and b.backfill_completed_at >= ${at(since)})`,
        sql`not exists (select 1 from app_settings s where s.key = 'first-drafts-ready:' || ${workspaces.id}::text)`,
      ),
    );
  let sent = 0;
  for (const r of rows) {
    if (!jobsAllowed(r.workspace, now)) continue;
    const totals = await queueCounts(r.workspace.id, now);
    if (!totals.drafts) continue;
    // During the trial this is the trial's day-1 email (2026-10-16): it says how sending works
    // then, carries the one-click stop link, and isn't emailed to someone who stopped them.
    const trial = effectiveStatus(r.workspace, now) === "evaluating";
    const stopLink = trial ? stopLinkFor(r.workspace.id) : null;
    const emailIt = !trial || !r.workspace.trialEmailsStoppedAt;
    const c = firstDraftsEmailCopy({ queueUrl: appUrl("/queue"), drafts: totals.drafts, trial });
    const { text, html } = brandEmail({
      serif: c.serif,
      heavy: c.heavy,
      lines: c.lines,
      button: c.button,
      footer: c.footer,
      ...(stopLink ? { stopLink: { label: STOP_TRIAL_EMAILS_LABEL, url: stopLink } } : {}),
    });
    let emailed = false;
    try {
      const outcome = emailIt
        ? await send({
            to: r.ownerEmail,
            subject: c.subject,
            text,
            html,
            idempotencyKey: `first-drafts-${r.workspace.id}`,
            ...(stopLink ? { headers: stopHeaders(stopLink) } : {}),
          })
        : "not_configured";
      emailed = outcome !== "not_configured";
    } catch (err) {
      // Tried again on the next run; the error's name only.
      console.error("first_drafts_email_failed", {
        workspaceId: r.workspace.id,
        error: err instanceof Error ? err.name : "unknown",
      });
      continue;
    }
    let phones = 0;
    if (push) {
      const endpoints = (await pushEndpointsByWorkspace(r.workspace.id)).get(r.workspace.id) ?? [];
      for (const endpoint of endpoints) {
        const p = await push(endpoint);
        if (p === "gone") await removePushSubscription(r.workspace.id, endpoint);
        if (p === "sent") phones++;
      }
    }
    if (!emailed && !phones) continue;
    await db()
      .insert(appSettings)
      .values({ key: firstDraftsKey(r.workspace.id), value: now.toISOString() })
      .onConflictDoNothing();
    await db()
      .insert(activityLog)
      .values({
        workspaceId: r.workspace.id,
        actor: "squared_away",
        action: "first_drafts_ready_sent",
        detail: { email: emailed, phones },
      });
    sent++;
  }
  return { sent };
}

// ---------------------------------------------------------------------------------------------
// FW F2 / E7: the trial's numbers

/** What the three days did so far: conversations sorted and drafts written since the start. */
export async function trialCounts(workspace: Workspace) {
  const start = workspace.evaluationStartedAt;
  if (!start) return { sorted: 0, drafted: 0 };
  const boxIds = (
    await db()
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.workspaceId, workspace.id))
  ).map((b) => b.id);
  if (!boxIds.length) return { sorted: 0, drafted: 0 };
  const [sorted] = await db()
    .select({ n: count() })
    .from(threads)
    .where(and(inArray(threads.mailboxId, boxIds), gte(threads.classifiedAt, start)));
  const [drafted] = await db()
    .select({ n: count() })
    .from(drafts)
    .where(and(inArray(drafts.mailboxId, boxIds), gte(drafts.createdAt, start)));
  return { sorted: sorted?.n ?? 0, drafted: drafted?.n ?? 0 };
}
