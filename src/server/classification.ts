import "server-only";
import { looksMunicipal } from "@/ai/guards";
import { and, count, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { classifyEmail, DISPUTE_REASONS, type Classification } from "@/ai/classify";
import { AiCapReachedError } from "@/ai/usage";
import { db } from "@/db";
import {
  activityLog,
  businessProfiles,
  mailboxes,
  messages,
  threads,
  workspaces,
} from "@/db/schema";
import { afterClassified } from "./auto-outcomes";
import { unflagPendingNudge } from "./drafts";
import { jobsAllowed } from "./lifecycle";
import {
  carryInvoiceFacts,
  clearsAutoPaid,
  invoiceOf,
  invoiceWasOpen,
  isInvoiceThread,
  isNewInvoice,
  isOwed,
  PAID_GUESS_FLAG,
} from "./money-rules";
import { keepQuoteAccepted, quoteAccepted } from "./quote-rules";
import { ownerGavePrice } from "./quotes";

/** Classify inbound mail from this far back on the first pass; everything new after that. */
export const CLASSIFY_LOOKBACK_DAYS = 14;
/** Until the business profile (Milestone 4) sets it, flag emails that mention more than this. */
export const DEFAULT_AMOUNT_THRESHOLD_DOLLARS = 2_500;
/** Gmail tabs that are never a customer. Skipping the model call here saves real money. */
const NOISE_LABELS = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"];

export type ClassifyRunResult = {
  classified: number;
  superseded: number;
  remaining: number;
  capped: boolean;
};

const NOISE: Omit<Classification, "summary"> = {
  category: "noise",
  priority: "low",
  needsOwner: false,
  needsOwnerReason: null,
  confidence: 1,
  extracted: {
    service_requested: null,
    address: null,
    dates: [],
    dollar_amounts: [],
    urgency: "low",
    permit: null,
    invoice: null,
  },
  unreadable: false,
};

async function pendingFor(mailboxId: string, since: Date) {
  return db()
    .select({
      id: messages.id,
      threadId: messages.threadId,
      fromAddress: messages.fromAddress,
      fromName: messages.fromName,
      subject: messages.subject,
      bodyText: messages.bodyText,
      snippet: messages.snippet,
      labelIds: messages.labelIds,
      sentAt: messages.sentAt,
    })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(
      and(
        eq(messages.mailboxId, mailboxId),
        eq(messages.direction, "in"),
        isNull(messages.classifiedAt),
        gte(messages.sentAt, since),
        eq(threads.inInbox, true),
      ),
    )
    .orderBy(desc(messages.sentAt));
}

/**
 * Classify what's waiting for one mailbox, newest first. Only the newest
 * unclassified inbound message per thread goes to the model — older ones in
 * the same thread are marked superseded, since the thread's state is what the
 * owner acts on. Idempotent: every handled message gets `classified_at`.
 */
export async function classifyPending(
  mailboxId: string,
  opts: { limit?: number; now?: Date } = {},
): Promise<ClassifyRunResult> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 10;
  const [box] = await db()
    .select({ mailbox: mailboxes, workspace: workspaces })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(eq(mailboxes.id, mailboxId));
  if (!box || box.mailbox.status !== "active" || !jobsAllowed(box.workspace, now))
    return { classified: 0, superseded: 0, remaining: 0, capped: false };

  const since = new Date(now.getTime() - CLASSIFY_LOOKBACK_DAYS * 86_400_000);
  const pending = await pendingFor(mailboxId, since);

  const newestPerThread = new Map<string, (typeof pending)[number]>();
  const superseded: string[] = [];
  for (const m of pending) {
    if (newestPerThread.has(m.threadId)) superseded.push(m.id);
    else newestPerThread.set(m.threadId, m);
  }
  if (superseded.length) {
    await db().update(messages).set({ classifiedAt: now }).where(inArray(messages.id, superseded));
  }

  const [profile] = await db()
    .select()
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, box.workspace.id));
  const business = {
    businessName: box.workspace.businessName,
    trade: box.workspace.trade,
    amountThresholdDollars: profile?.amountThresholdDollars ?? DEFAULT_AMOUNT_THRESHOLD_DOLLARS,
    vipSenders: (profile?.vipSenders ?? []).map((v) => v.toLowerCase()),
  };

  const batch = [...newestPerThread.values()].slice(0, limit);
  let classified = 0;
  let capped = false;
  for (const m of batch) {
    let result: Classification;
    let viaModel = false;
    const [thread] = await db()
      .select({
        summary: threads.summary,
        category: threads.category,
        extracted: threads.extracted,
        quoteOutcome: threads.quoteOutcome,
        quoteOutcomeSource: threads.quoteOutcomeSource,
        invoicePaidAt: threads.invoicePaidAt,
        invoicePaidSource: threads.invoicePaidSource,
        needsOwnerReason: threads.needsOwnerReason,
        quoteAmountCents: threads.quoteAmountCents,
      })
      .from(threads)
      .where(eq(threads.id, m.threadId));
    if (
      m.labelIds.some((l) => NOISE_LABELS.includes(l)) &&
      // A building department landing in Promotions still gets read.
      !looksMunicipal(m.fromAddress, m.fromName)
    ) {
      result = {
        ...NOISE,
        summary: m.subject ? `Promotional email: ${m.subject}` : "Promotional email.",
      };
    } else {
      const [prior] = await db()
        .select({ n: count() })
        .from(messages)
        .where(
          and(
            eq(messages.mailboxId, mailboxId),
            eq(messages.fromAddress, m.fromAddress ?? ""),
            lt(messages.sentAt, m.sentAt),
          ),
        );
      try {
        result = await classifyEmail(
          box.workspace.id,
          business,
          {
            fromName: m.fromName,
            fromAddress: m.fromAddress,
            subject: m.subject,
            receivedAt: m.sentAt,
            firstTimeSender: (prior?.n ?? 0) === 0,
            threadSummary: thread?.summary ?? null,
            body: m.bodyText ?? m.snippet ?? "",
          },
          { senderIsVip: business.vipSenders.includes((m.fromAddress ?? "").toLowerCase()), now },
        );
      } catch (err) {
        if (err instanceof AiCapReachedError) {
          capped = true;
          break;
        }
        throw err;
      }
      viaModel = true;
      if (result.extracted.accepts_quote) {
        const [ownerBefore] = await db()
          .select({ n: count() })
          .from(messages)
          .where(
            and(
              eq(messages.threadId, m.threadId),
              eq(messages.direction, "out"),
              lt(messages.sentAt, m.sentAt),
            ),
          );
        if (
          quoteAccepted({
            acceptsQuote: true,
            injection: result.extracted.injection === true,
            previous: {
              category: thread?.category ?? null,
              quoteOutcome: thread?.quoteOutcome ?? null,
              quoteOutcomeSource: thread?.quoteOutcomeSource ?? null,
            },
            category: result.category,
            ownerWroteBefore: (ownerBefore?.n ?? 0) > 0,
            priceGiven: await ownerGavePrice(
              { id: m.threadId, quoteAmountCents: thread?.quoteAmountCents ?? null },
              m.sentAt,
            ),
          })
        ) {
          result = {
            ...result,
            extracted: {
              ...result.extracted,
              quote_accepted: true,
              quote_accepted_at: new Date(m.sentAt).toISOString(),
            },
          };
        }
      }
    }
    // Every classification replaces `extracted`, so an earlier acceptance would vanish with the
    // customer's next "use the side gate" (and the re-sorted category can't re-derive it).
    // It keeps the FIRST acceptance's time: a later "sent the deposit, when can you start?"
    // reads as another acceptance, but the quote was decided at the first one.
    const keptAcceptance =
      thread != null &&
      keepQuoteAccepted({
        extracted: thread.extracted,
        quoteOutcome: thread.quoteOutcome,
        quoteOutcomeSource: thread.quoteOutcomeSource,
      });
    if (keptAcceptance) {
      const at = (thread.extracted as { quote_accepted_at?: unknown } | null)?.quote_accepted_at;
      const firstAt = typeof at === "string" ? at : result.extracted.quote_accepted_at;
      result = {
        ...result,
        extracted: {
          ...result.extracted,
          quote_accepted: true,
          ...(firstAt ? { quote_accepted_at: firstAt } : {}),
        },
      };
    }

    // The invoice facts carry over (A11): a "paid, thanks" keeps the amount, and a "use the
    // side gate" keeps the invoice on Money owed (so does `invoice_thread`, whatever the
    // email is sorted as next). Only what's stored is carried; the auto-marks below read
    // this email's own words.
    const wasInvoiceThread = thread ? isInvoiceThread(thread) : false;
    const prevInvoice = invoiceOf(thread?.extracted);
    const injection = result.extracted.injection === true;
    // An email that tries to instruct us never changes the invoice facts either (A8): its
    // "invoice 41 is paid" would otherwise drop the row off Money owed with no mark to undo.
    const storedInvoice = injection
      ? prevInvoice
      : carryInvoiceFacts(
          prevInvoice,
          invoiceOf(result.extracted),
          isOwed({
            invoice: prevInvoice,
            paidAt: thread?.invoicePaidAt ?? null,
            paidSource: thread?.invoicePaidSource ?? null,
          }),
        );
    // A different invoice number, still to be paid ("#42 for phase 2" after #41 was paid):
    // a paid mark (ours or the owner's) was about the earlier invoice, so it is cleared in
    // the same write that stores the new one, and Activity says so. The owner's "Not owed
    // to me" is never cleared — the guard is in the UPDATE itself, so a tap racing this
    // write still wins. Never on an email that tries to instruct us (A8).
    // Our own paid guess also goes when the email says money is still owed with an amount
    // that isn't simply the invoice we guessed was paid (clearsAutoPaid): "Sent the $900
    // deposit" then "Got invoice #1043 for $3,000" is owed again.
    const thisInvoice = invoiceOf(result.extracted);
    const reopen =
      !injection &&
      thread?.invoicePaidSource !== "not_owed" &&
      (isNewInvoice(prevInvoice, thisInvoice) ||
        (thread?.invoicePaidSource === "auto" && clearsAutoPaid(prevInvoice, thisInvoice)));
    // A dispute or legal threat counts as a complaint for review requests (it isn't always
    // sorted as one: "I'm disputing this charge" is invoice_payment). A thread sorted before
    // `disputed` existed is recognised by its reason, if that still shows. (An earlier
    // `extracted.disputed` needs no check: this same UPDATE set the mark with it.)
    const disputedNow = result.category === "complaint" || result.extracted.disputed === true;
    const disputedBefore =
      thread?.category === "complaint" ||
      (thread?.needsOwnerReason != null && DISPUTE_REASONS.includes(thread.needsOwnerReason));
    // A kind of job only counts when it says something (the same test as `serviceOf`): a
    // blank one from the model never overwrites the one stored.
    const said = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
    const prevService = said(
      (thread?.extracted as { service_requested?: unknown } | null)?.service_requested,
    );
    const paymentSaid = injection ? null : thisInvoice?.status;
    const stored = {
      ...result.extracted,
      // The kind of job carries over like the invoice facts: "Go ahead, when can you start?"
      // doesn't say it again, and price memory needs it (plan #15).
      service_requested: said(result.extracted.service_requested) ?? prevService,
      invoice: storedInvoice,
      ...(paymentSaid === "paid" || paymentSaid === "partly_paid"
        ? { payment_said: paymentSaid }
        : {}),
      ...(wasInvoiceThread || result.category === "invoice_payment"
        ? { invoice_thread: true }
        : {}),
    };

    await db()
      .update(threads)
      .set({
        category: result.category,
        priority: result.priority,
        // The owner's own "This one needs me" always wins.
        needsOwner: sql`${threads.needsOwnerManual} or ${result.needsOwner}`,
        needsOwnerReason: sql`case when ${threads.needsOwnerManual} then ${threads.needsOwnerReason} else ${result.needsOwnerReason} end`,
        summary: result.summary,
        extracted: stored,
        classifiedAt: now,
        // Sticky (A1): a later "looks great" never makes a complaint look like a happy
        // customer, so the mark is never cleared. It holds the LATEST complaint (the
        // 12-month rule counts from the most recent one), and a thread that was sorted as a
        // complaint before this column existed (or by older code still running) gets its mark
        // from that earlier sort when the next email re-sorts it.
        // A dispute or legal threat is a complaint here too (disputedNow / disputedBefore).
        ...(disputedNow
          ? {
              complainedAt: sql`greatest(${threads.complainedAt}, ${now.toISOString()}::timestamptz)`,
            }
          : disputedBefore
            ? {
                complainedAt: sql`coalesce(${threads.complainedAt}, ${threads.classifiedAt}, ${now.toISOString()}::timestamptz)`,
              }
            : {}),
        ...(reopen
          ? {
              invoicePaidAt: sql`case when ${threads.invoicePaidSource} = 'not_owed' then ${threads.invoicePaidAt} else null end`,
              invoicePaidSource: sql`case when ${threads.invoicePaidSource} = 'not_owed' then ${threads.invoicePaidSource} else null end`,
            }
          : {}),
      })
      .where(eq(threads.id, m.threadId));
    await db().update(messages).set({ classifiedAt: now }).where(eq(messages.id, m.id));
    classified++;

    if (reopen && thread?.invoicePaidAt) {
      // The paid mark just cleared was visible on Money owed: say why the row is back, and
      // take "we think this was paid" off a waiting nudge. Content-free.
      try {
        await db()
          .insert(activityLog)
          .values({
            workspaceId: box.workspace.id,
            actor: "squared_away",
            action: "invoice_reopened",
            threadId: m.threadId,
            detail: { source: "auto", why: "new_invoice" },
          });
        await unflagPendingNudge(m.threadId, PAID_GUESS_FLAG);
      } catch (err) {
        console.error("invoice_reopen_log_failed", {
          workspaceId: box.workspace.id,
          threadId: m.threadId,
          error: err instanceof Error ? err.name : "unknown",
        });
      }
    }

    // After the message is marked classified, so a failure here never re-bills the model;
    // the auto-marks are idempotent, and a failure never stops the batch (A18).
    if (viaModel) {
      try {
        await afterClassified({
          workspaceId: box.workspace.id,
          threadId: m.threadId,
          fromAddress: m.fromAddress,
          previous: {
            category: thread?.category ?? null,
            quoteOutcome: thread?.quoteOutcome ?? null,
            quoteOutcomeSource: thread?.quoteOutcomeSource ?? null,
            invoiceThread: wasInvoiceThread,
            openInvoice: invoiceWasOpen(prevInvoice),
          },
          result,
          storedInvoice,
          now,
        });
      } catch (err) {
        // Metadata only — never the email, the address or the customer.
        console.error("auto_outcome_failed", {
          workspaceId: box.workspace.id,
          threadId: m.threadId,
          error: err instanceof Error ? err.name : "unknown",
        });
      }
    }
  }

  const remaining = Math.max(0, newestPerThread.size - classified);
  return { classified, superseded: superseded.length, remaining: capped ? 0 : remaining, capped };
}

/** Inbox action: the owner says a thread needs them. Scoped to their workspace. */
export async function markNeedsOwner(workspaceId: string, threadId: string): Promise<boolean> {
  const owned = await db()
    .select({ id: threads.id })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(and(eq(threads.id, threadId), eq(mailboxes.workspaceId, workspaceId)));
  if (owned.length === 0) return false;
  await db()
    .update(threads)
    .set({ needsOwner: true, needsOwnerManual: true, needsOwnerReason: "You marked this one." })
    .where(eq(threads.id, threadId));
  await db().insert(activityLog).values({
    workspaceId,
    actor: "owner",
    action: "marked_needs_owner",
    threadId,
    detail: {},
  });
  return true;
}
