import "server-only";
import { injectionCheck, looksMunicipal } from "@/ai/guards";
import { and, count, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  classifyEmail,
  codeOnlyClassification,
  DISPUTE_REASONS,
  type Classification,
} from "@/ai/classify";
import { AiCapReachedError } from "@/ai/usage";
import { OTHER_JOB_KIND } from "@/config/job-kinds";
import { db } from "@/db";
import {
  activityLog,
  businessProfiles,
  mailboxes,
  messages,
  threads,
  workspaces,
} from "@/db/schema";
import { mailboxOn } from "./mailbox-plan-rules";
import { recentEmergency } from "./emergency-rules";
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
import { jobKindOf } from "./monthly-rules";
import { keepQuoteAccepted, quoteAccepted } from "./quote-rules";
import { ownerGavePrice } from "./quotes";
import { messageReplyAddress, notDraftMessage, notDraftSql, sideEmailSql } from "./thread-sql";
import { customerReplyAddress, replyRedirected } from "./reply-address-rules";
import { junkShortcutBlocked, matchRules } from "./owner-sender-rule-rules";
import { rulesForWorkspace } from "./sender-rule-store";
import { channelName, channelOf } from "./channel-rules";

/** Classify inbound mail from this far back on the first pass; everything new after that. */
export const CLASSIFY_LOOKBACK_DAYS = 14;
/** Until the business profile (Milestone 4) sets it, flag emails that mention more than this. */
export const DEFAULT_AMOUNT_THRESHOLD_DOLLARS = 2_500;
/**
 * A burst (review B4): unsorted emails on the same thread written this close before the newest
 * one are sorted together with it, so "water through the ceiling, call me" followed a minute
 * later by "here's a photo" is still an emergency. At most BURST_MAX earlier emails.
 */
export const BURST_WINDOW_MS = 30 * 60_000;
export const BURST_MAX = 4;
/** Gmail tabs that are never a customer. Skipping the model call here saves real money. */
const NOISE_LABELS = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"];

export type ClassifyRunResult = {
  classified: number;
  superseded: number;
  remaining: number;
  capped: boolean;
  /**
   * Check 39 P1: emails stored by the checks in code alone after the day's AI limit was hit (a
   * gas smell, a CO alarm, a new bank account, an attack). Also counted in `classified`.
   */
  codeOnly: number;
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
    invoice_direction: "unknown",
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
      replyToHeader: messages.replyToHeader,
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
  // Lost access or paused on the plan (2026-10-16): nothing is sorted, no AI spent.
  if (!box || !mailboxOn(box.mailbox) || !jobsAllowed(box.workspace, now))
    return { classified: 0, superseded: 0, remaining: 0, capped: false, codeOnly: 0 };

  const since = new Date(now.getTime() - CLASSIFY_LOOKBACK_DAYS * 86_400_000);
  const pending = await pendingFor(mailboxId, since);

  const newestPerThread = new Map<string, (typeof pending)[number]>();
  // The older unsorted emails of each thread, newest first. Marked superseded only once their
  // thread's newest email is sorted (with them in view), so a run that stops early (the AI
  // cap, an outage) leaves them for the next run instead of losing them (review B3, B4, D4).
  const olderPerThread = new Map<string, (typeof pending)[number][]>();
  for (const m of pending) {
    if (newestPerThread.has(m.threadId))
      olderPerThread.set(m.threadId, [...(olderPerThread.get(m.threadId) ?? []), m]);
    else newestPerThread.set(m.threadId, m);
  }
  let superseded = 0;

  const [profile] = await db()
    .select()
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, box.workspace.id));
  const business = {
    businessName: box.workspace.businessName,
    trade: box.workspace.trade,
    extraTrades: box.workspace.extraTrades ?? [],
    amountThresholdDollars: profile?.amountThresholdDollars ?? DEFAULT_AMOUNT_THRESHOLD_DOLLARS,
    vipSenders: (profile?.vipSenders ?? []).map((v) => v.toLowerCase()),
    serviceTowns: profile?.serviceTowns ?? [],
  };
  // The owner's sender rules (ideas H3), read once per run. Never sent to the model.
  const senderRules = await rulesForWorkspace(box.workspace.id);

  const batch = [...newestPerThread.values()].slice(0, limit);
  let classified = 0;
  let codeOnly = 0;
  let capped = false;
  for (const m of batch) {
    let result: Classification;
    let viaModel = false;
    const older = olderPerThread.get(m.threadId) ?? [];
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
        quoteRequestedAt: threads.quoteRequestedAt,
        categoryManual: threads.categoryManual,
      })
      .from(threads)
      .where(eq(threads.id, m.threadId));
    const prevMarks = (thread?.extracted ?? {}) as {
      injection?: unknown;
      payment_change?: unknown;
    };
    // The burst the model reads with it (B4), oldest first.
    const earlier = older
      .filter(
        (o) =>
          m.sentAt.getTime() - o.sentAt.getTime() <= BURST_WINDOW_MS &&
          o.fromAddress === m.fromAddress,
      )
      .slice(0, BURST_MAX)
      .reverse()
      .map((o) => ({ receivedAt: o.sentAt, body: o.bodyText ?? o.snippet ?? "" }));
    // Every older unsorted email is checked in code too, even outside the burst (B3): the
    // drafter reads them.
    const alsoCheck = older.map((o) => `${o.subject ?? ""}\n${o.bodyText ?? o.snippet ?? ""}`);
    // A thread once caught trying to instruct us (or asking to pay a new account) keeps that
    // mark: "any update?" doesn't clear it (B3).
    const sticky = {
      injection: prevMarks.injection === true,
      paymentChange: prevMarks.payment_change === true,
    };
    // Check 39 P1: past the day's AI limit, only what the checks in code catch is stored now (a
    // gas smell, a CO alarm, a new bank account, an attack), through the same write as any
    // other result. Everything else stays unsorted for the model after the reset.
    const codeOnlyResult = () =>
      codeOnlyClassification(
        {
          fromName: m.fromName,
          fromAddress: m.fromAddress,
          subject: m.subject,
          receivedAt: m.sentAt,
          firstTimeSender: false,
          threadSummary: null,
          body: m.bodyText ?? m.snippet ?? "",
          earlier,
        },
        { alsoCheck, sticky },
      );
    // Where it came from, decided in code from the sender (leads package): a voicemail or
    // text-message email, a lead website, or null for a person writing directly.
    const channel = channelOf(m.fromAddress);
    // Ideas H3: the owner's sender rules. Caution (a VIP, a company "Always needs me") matches
    // the sender or the reply address; "Always junk" only the sender, in the safe direction.
    const rule = matchRules(senderRules, {
      from: m.fromAddress,
      replyAddress: customerReplyAddress(m),
      replyToHeader: m.replyToHeader,
      vips: business.vipSenders,
    });
    const ruleText = `${m.subject ?? ""}\n${m.bodyText ?? m.snippet ?? ""}`;
    const junkByRule =
      rule.junk &&
      !thread?.categoryManual &&
      // Voicemail and text-message emails are always read (leads package): a company rule
      // (say, everyone at google.com) never quietly junks a caller.
      channel?.kind !== "phone" &&
      channel?.kind !== "phone_text" &&
      !looksMunicipal(m.fromAddress, m.fromName) &&
      prevMarks.injection !== true &&
      prevMarks.payment_change !== true &&
      !injectionCheck(ruleText).flagged &&
      !junkShortcutBlocked(ruleText);
    if (capped) {
      const code = codeOnlyResult();
      if (!code) continue;
      result = code;
      codeOnly++;
    } else if (junkByRule) {
      // No model call: the owner said this sender is junk, and nothing in it says otherwise.
      result = {
        ...NOISE,
        summary: m.subject ? `Junk (your rule): ${m.subject}` : "Junk (your rule).",
        extracted: { ...NOISE.extracted, sender_rule: "junk" },
      };
    } else if (
      m.labelIds.some((l) => NOISE_LABELS.includes(l)) &&
      // Voicemail and text-message emails are few and never marketing: always read. Lead
      // websites keep the shortcut (their marketing would eat the daily AI limit).
      channel?.kind !== "phone" &&
      channel?.kind !== "phone_text" &&
      // A building department landing in Promotions still gets read.
      !looksMunicipal(m.fromAddress, m.fromName) &&
      // A thread already marked keeps its mark (B3): it is never quietly turned into junk.
      prevMarks.injection !== true &&
      prevMarks.payment_change !== true
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
      // A website form writes from one robot address for every lead: the person is the
      // Reply-To. A new person through a known form is still a first-time sender (B1).
      const replyTo = replyRedirected(m) ? customerReplyAddress(m) : null;
      const [priorReply] = replyTo
        ? await db()
            .select({ n: count() })
            .from(messages)
            .where(
              and(
                eq(messages.mailboxId, mailboxId),
                eq(messages.direction, "in"),
                sql`${messageReplyAddress()} = ${replyTo}`,
                lt(messages.sentAt, m.sentAt),
              ),
            )
        : [{ n: 1 }];
      const firstTimeSender = (prior?.n ?? 0) === 0 || (priorReply?.n ?? 0) === 0;
      // VIP by either address: both only add caution.
      const senderIsVip = [m.fromAddress, replyTo].some(
        (a) => !!a && business.vipSenders.includes(a.toLowerCase()),
      );
      let fromModel: Classification | null = null;
      try {
        fromModel = await classifyEmail(
          box.workspace.id,
          business,
          {
            fromName: m.fromName,
            fromAddress: m.fromAddress,
            subject: m.subject,
            receivedAt: m.sentAt,
            firstTimeSender,
            threadSummary: thread?.summary ?? null,
            body: m.bodyText ?? m.snippet ?? "",
            earlier,
          },
          {
            senderIsVip,
            senderNeedsMe: rule.caution === "needs_me",
            now,
            alsoCheck,
            sticky,
            channel: channel ? { kind: channel.kind, name: channelName(channel.key) ?? "" } : null,
            serviceTowns: business.serviceTowns,
          },
        );
      } catch (err) {
        if (!(err instanceof AiCapReachedError)) throw err;
        // Check 39 P1: the limit was reached on this email. Don't stop the batch: this one and
        // every later one still get the checks in code.
        capped = true;
      }
      if (!fromModel) {
        const code = codeOnlyResult();
        if (!code) continue;
        result = code;
        codeOnly++;
      } else {
        viaModel = true;
        // What the sorter itself said (ideas H4): a kind the owner chose never feeds automatic
        // drafts or autopilot unless the sorter's own kind would have. Content-free.
        result = {
          ...fromModel,
          extracted: {
            ...fromModel.extracted,
            model_category: fromModel.category,
            ...(rule.noDraft ? { sender_rule: "no_draft" as const } : {}),
          },
        };
      }
      if (viaModel && result.extracted.accepts_quote) {
        const [ownerBefore] = await db()
          .select({ n: count() })
          .from(messages)
          .where(
            and(
              eq(messages.threadId, m.threadId),
              eq(messages.direction, "out"),
              // An unsent Gmail draft isn't the owner having written.
              notDraftMessage(),
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
    // Which way the money goes (round 2, TW A2): a supplier's bill is owed BY the owner and
    // never shows on Money owed. This email's own answer, else the one stored before; an
    // email that tries to instruct us never changes it.
    const dirNow = (result.extracted as { invoice_direction?: unknown }).invoice_direction;
    const dirBefore = (thread?.extracted as { bill_direction?: unknown } | null)?.bill_direction;
    const isDir = (v: unknown): v is "owed_to_business" | "owed_by_business" =>
      v === "owed_to_business" || v === "owed_by_business";
    const billDirection =
      !injection && isDir(dirNow) ? dirNow : isDir(dirBefore) ? dirBefore : null;
    // Check 36 P2: an emergency marks the thread for 48 hours (from the emergency email), kept
    // across later sorts so autopilot and batch send stay away. Never from an attack email.
    const emergencyNow =
      !injection &&
      ((result.extracted.owner_rule_hits ?? []).includes("emergency") ||
        result.extracted.gas_smell === true ||
        result.extracted.co_alarm === true ||
        result.extracted.electrical_hazard === true);
    const prevEmergencyAt = recentEmergency(thread?.extracted, now)
      ? (thread?.extracted as { emergency_at: string }).emergency_at
      : null;
    const emergencyAt = emergencyNow ? new Date(m.sentAt).toISOString() : prevEmergencyAt;
    // Check 22 P2: the owner's "This is a normal email" is kept across later sorts (autopilot
    // reads its date); the mark itself is gone, so `sticky` no longer carries it.
    const cleared = thread?.extracted as
      { injection_cleared_by_owner?: unknown; injection_cleared_at?: unknown } | null | undefined;
    const stored = {
      ...result.extracted,
      ...(cleared?.injection_cleared_by_owner === true &&
      typeof cleared.injection_cleared_at === "string"
        ? {
            injection_cleared_by_owner: true,
            injection_cleared_at: cleared.injection_cleared_at,
          }
        : {}),
      ...(emergencyAt ? { emergency: true, emergency_at: emergencyAt } : {}),
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
      ...(billDirection ? { bill_direction: billDirection } : {}),
    };

    // Sticky quote-request facts (M8 A11), content-free. A quote request re-sorted as
    // scheduling ("Tuesday works") still counts as one in the scorecard and the monthly
    // summary. The time (what response time and the monthly counts measure from) is the
    // customer's first email since the owner last wrote: only the newest email of a sync is
    // sorted, so a request and its "photos attached" arrive as one, while a new job asked for
    // on an older conversation the owner already answered dates from the new request, not the
    // old chat. "The owner wrote" is the same rule as everywhere (`lastOutSql`): not an unsent
    // Gmail draft, not a forward to the crew (nor the crew's reply to it). A thread sorted as a
    // quote by older code has no record of which email that was, so it takes the thread's
    // first customer email. The kind of job is OUR fixed label, never the customer's words; a
    // real kind replaces "Other jobs", but never another real kind.
    // An email that tries to instruct us leaves no mark (no automatic marks from it): these
    // drive counts and "a lead is waiting" alerts, and they are never cleared.
    const prevInjection = (thread?.extracted as { injection?: unknown } | null)?.injection === true;
    const legacyQuote = thread?.category === "quote_request" && !prevInjection;
    const wasQuote =
      legacyQuote ||
      thread?.quoteRequestedAt != null ||
      thread?.quoteOutcome != null ||
      thread?.quoteOutcomeSource != null;
    // The owner's own kind (ideas H4) wins, decided in SQL so a "Move it" tapped while the
    // model was reading isn't overwritten: `category = coalesce(category_manual, model)`.
    const effectiveCategory = sql`coalesce(${threads.categoryManual}, ${result.category})`;
    const isQuoteNow = result.category === "quote_request";
    const markQuote = !injection && (legacyQuote || isQuoteNow || thread?.categoryManual != null);
    const quoteNowSql = sql`(${legacyQuote ? sql`true` : sql`false`} or ${effectiveCategory} = 'quote_request')`;
    const requestAt = new Date(m.sentAt).toISOString();
    const jobKind =
      !injection && (wasQuote || isQuoteNow || thread?.categoryManual != null)
        ? jobKindOf(
            box.workspace.trade,
            stored.service_requested ?? null,
            box.workspace.extraTrades ?? [],
          )
        : null;

    await db()
      .update(threads)
      .set({
        category: effectiveCategory,
        priority: result.priority,
        // The owner's own "This one needs me" always wins.
        needsOwner: sql`${threads.needsOwnerManual} or ${result.needsOwner}`,
        needsOwnerReason: sql`case when ${threads.needsOwnerManual} then ${threads.needsOwnerReason} else ${result.needsOwnerReason} end`,
        summary: result.summary,
        extracted: stored,
        classifiedAt: now,
        // Leads package: kept once set — a later email on the thread doesn't clear it.
        ...(channel ? { leadChannel: channel.key } : {}),
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
        ...(markQuote
          ? {
              // `requestAt` is an ISO string, never a Date: postgres.js can't bind a Date
              // inside raw SQL (A10; the classification tests' driver refuses one).
              quoteRequestedAt: sql`case when not ${quoteNowSql} then ${threads.quoteRequestedAt} else coalesce(${threads.quoteRequestedAt}, ${
                legacyQuote
                  ? sql`(select min(i.sent_at) from messages i where i.thread_id = ${threads.id} and i.direction = 'in')`
                  : sql`(select min(i.sent_at) from messages i where i.thread_id = ${threads.id} and i.direction = 'in' and not ${sideEmailSql("i")} and i.sent_at <= ${requestAt}::timestamptz and i.sent_at > coalesce((select max(o.sent_at) from messages o where o.thread_id = ${threads.id} and o.direction = 'out' and ${notDraftSql("o")} and not ${sideEmailSql("o")} and o.sent_at < ${requestAt}::timestamptz), '-infinity'::timestamptz))`
              }, ${requestAt}::timestamptz) end`,
            }
          : {}),
        ...(jobKind === null
          ? {}
          : jobKind === OTHER_JOB_KIND
            ? {
                jobKind: sql`case when ${wasQuote ? sql`true` : sql`false`} or ${effectiveCategory} = 'quote_request' then coalesce(${threads.jobKind}, ${jobKind}) else ${threads.jobKind} end`,
              }
            : {
                jobKind: sql`case when not (${wasQuote ? sql`true` : sql`false`} or ${effectiveCategory} = 'quote_request') then ${threads.jobKind} when ${threads.jobKind} is null or ${threads.jobKind} = ${OTHER_JOB_KIND} then ${jobKind} else ${threads.jobKind} end`,
              }),
        ...(reopen
          ? {
              invoicePaidAt: sql`case when ${threads.invoicePaidSource} = 'not_owed' then ${threads.invoicePaidAt} else null end`,
              invoicePaidSource: sql`case when ${threads.invoicePaidSource} = 'not_owed' then ${threads.invoicePaidSource} else null end`,
            }
          : {}),
      })
      .where(eq(threads.id, m.threadId));
    // The newest email and the older ones sorted with it, in one write (B3, B4).
    await db()
      .update(messages)
      .set({ classifiedAt: now })
      .where(inArray(messages.id, [m.id, ...older.map((o) => o.id)]));
    superseded += older.length;
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
  return { classified, superseded, remaining: capped ? 0 : remaining, capped, codeOnly };
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
