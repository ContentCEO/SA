import "server-only";
import { and, count, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { pricing } from "@/config/pricing";
import { daysPhrase } from "@/lib/trial-words";
import { categoryLabels, categoryTag, isCategory } from "@/config/categories";
import { db } from "@/db";
import { activityLog, drafts, mailboxes, messages, threads } from "@/db/schema";
import { MINUTES_PER_SENT_REPLY } from "@/config/drafting";
import { dollarsToCents, tally, type MoneySoFar, type MonthMoney } from "./activity-rules";
import { invoiceTotals } from "./money";
import { atRiskActivityLine } from "./leads-at-risk-rules";
import { emergencyActivityLine } from "./emergency-alert-rules";
import { invoiceOf } from "./money-rules";
import {
  closeRate,
  isLostReason,
  isQuoteOutcome,
  type LostReason,
  type QuoteOutcome,
} from "./quote-rules";
import { workspaceTimeZone } from "./snooze";
import { localMonthStart, usableTimeZone } from "./snooze-rules";
import { messageReplyName } from "./thread-sql";

// The time-saved assumption lives in config (pure files read it too); re-exported for old callers.
export { MINUTES_PER_SENT_REPLY } from "@/config/drafting";

type Who = { name: string | null; category: string | null };

const OUTCOME_WORDS: Record<QuoteOutcome, string> = {
  won: "won",
  lost: "lost",
  no_answer: "no answer",
};

/**
 * One activity row in plain words. The log itself is content-free; the
 * customer's name comes from the owner's own synced mail, shown only to them.
 * Returns null for entries the owner doesn't need to see.
 */
export function describeActivity(
  action: string,
  detail: Record<string, unknown>,
  who: Who | null,
): string | null {
  const name = who?.name?.split(/[\s,]+/)[0] || null;
  const to = name ? ` to ${name}` : "";
  const about = who?.category && isCategory(who.category) ? ` · ${categoryTag[who.category]}` : "";
  const from = name ? ` from ${name}` : "";
  switch (action) {
    case "draft_created":
      // Deposit details are always about a quote, even if the acceptance was sorted as scheduling.
      if (detail.purpose === "deposit")
        return `Drafted deposit details${name ? ` for ${name}` : ""}${who ? ` · ${categoryTag.quote_request}` : ""}`;
      if (detail.purpose === "review_request") return `Drafted a review request${to}`;
      if (detail.purpose === "thank_you") return `Drafted a thank-you for the payment${to}`;
      if (detail.purpose === "thank_you_review")
        return `Drafted a thank-you for the payment, with a review request${to}`;
      if (detail.purpose === "safety") return `Wrote a gas safety note${to}`;
      return `Drafted a reply${to}${about}`;
    case "closing_question":
      return `Drafted a question${to} asking if they went another way`;
    case "followup_drafted":
      return `Drafted a follow-up${to}${detail.nudgeNumber === 2 ? " (the last one)" : ""}${about}`;
    case "reply_sent":
      if (detail.autopilot) return `Autopilot sent a reply${to}${about}`;
      return `You sent ${detail.kind === "followup" ? "a follow-up" : "a reply"}${to}${
        detail.editedByOwner ? ", after editing it" : ""
      }`;
    case "reply_sent_from_gmail":
      return `You sent the draft${to} from Gmail`;
    case "draft_discarded":
      return `You discarded the draft${to}`;
    // Review B1: website-form leads now go to the customer's own address.
    case "draft_repointed":
      return "A draft now goes to the reply address the customer's email named, not the address it came from.";
    case "reply_went_to_form": {
      const on = typeof detail.sentOn === "string" ? shortDate(detail.sentOn) : null;
      // `robot` false: a person whose email named their other address; they likely have it.
      if (detail.robot === false)
        return `A reply you sent${on ? ` on ${on}` : ""}${to} went to the address their email came from, not the reply address it named. Check they got it.`;
      return `A reply you sent${on ? ` on ${on}` : ""}${to} went to the website form's address, so the customer may not have it. Send it again from Gmail.`;
    }
    case "draft_revised":
      return detail.via === "voice"
        ? `You changed the draft${to} by voice`
        : `You changed the draft${to} with a quick tweak`;
    case "practice_sent":
      return `You sent yourself a practice copy of the reply${to} — they got nothing`;
    case "send_undone":
      return `You stopped the reply${to} before it went`;
    case "send_stopped":
      return `Didn't send the reply${to} — ${
        detail.why === "changed_in_gmail"
          ? "it was changed in Gmail"
          : detail.why === "blocked"
            ? "sending was switched off"
            : detail.why === "reconnect_needed"
              ? "Gmail needs reconnecting"
              : "something changed"
      }. It's back in your queue`;
    case "snoozed":
      return `You put off the conversation${name ? ` with ${name}` : ""} till later`;
    case "draft_expired":
      return `Withdrew an out-of-date draft${to}`;
    case "quote_marked":
      return isQuoteOutcome(detail.outcome)
        ? `You marked a quote${from} as ${OUTCOME_WORDS[detail.outcome]}`
        : `You reopened a quote${from}`;
    case "quote_outcome_guessed":
      if (detail.outcome === "won")
        return `Marked a quote${from} as won — they said go ahead. Change it on Quotes`;
      if (detail.outcome === "no_answer")
        return `Marked a quote${from} as no answer after ${
          detail.why === "three_weeks" ? "three quiet weeks" : "two nudges and a quiet week"
        }. Change it on Quotes`;
      return null;
    case "invoice_marked_paid": {
      const whose = name ? `${name}'s invoice` : "an invoice";
      if (detail.source !== "auto") return `You marked ${whose} paid`;
      return detail.via === "receipt"
        ? `Marked ${whose} paid — a payment receipt matched it. Undo on Money owed`
        : `Marked ${whose} paid — they said they paid. Undo on Money owed`;
    }
    case "invoice_marked_unpaid":
      return `You put ${name ? `${name}'s invoice` : "an invoice"} back on the owed list`;
    case "invoice_marked_not_owed":
      return `You said ${name ? `${name}'s invoice` : "an invoice"} isn't owed to you`;
    case "invoice_reopened":
      return `${name ? `${name}'s conversation` : "A conversation"} mentions a new invoice, so it's back on Money owed`;
    // Ideas H3/H4/E7: content-free; never the address or the note.
    case "sender_rule_added":
      return "You set a sender rule";
    case "vip_added":
      return "You added a VIP";
    case "thread_resorted":
      return isCategory(detail.to)
        ? `You moved an email${from} to ${categoryLabels[detail.to]}`
        : null;
    case "away_on":
      return "You turned on away mode";
    case "away_off":
      return "You turned off away mode";
    // Ideas C5: the reason shows on Quotes and in the month's line, not as its own entry.
    case "quote_lost_reason":
      return null;
    case "marked_needs_owner":
      return `You marked a conversation${name ? ` with ${name}` : ""} as needing you`;
    case "mailbox_connected":
      return "You connected Gmail";
    case "mailbox_reconnected":
      return "You reconnected Gmail";
    case "mailbox_disconnected":
      return "You disconnected Gmail";
    case "push_alert_sent":
      return "Sent a notification to your phone about new emails that need you";
    case "lead_at_risk_push_sent":
      return atRiskActivityLine(detail.leads);
    case "sms_alert_sent":
      return "Texted you about new emails that need you";
    // Replies package (B5 part 2): counts only, never which email.
    case "emergency_alert_sent":
      return emergencyActivityLine(detail.emergencies);
    case "emergency_alerts_changed":
      return detail.enabled
        ? "You turned on emergency alerts, even at night"
        : "You turned off emergency alerts at night";
    case "sms_alerts_changed":
      return detail.enabled ? "You turned on text alerts" : "You turned off text alerts";
    case "access_alert_sent":
      return detail.reminder
        ? "Reminded you by email to reconnect Gmail"
        : "Emailed you that Gmail needs reconnecting";
    case "mailbox_access_lost":
      return "Lost access to Gmail — reconnect to carry on";
    case "voice_learned":
      return "Learned how you write from your sent mail";
    case "voice_idea_accepted":
      return "You took an idea from your edits for how drafts are written";
    case "voice_idea_ignored":
      return "You passed on an idea from your edits";
    case "voice_profile_edited":
      return "You edited how you write";
    case "business_profile_saved":
      return "You updated your business profile";
    case "followup_settings_saved":
      return detail.enabled
        ? `Follow-ups on, after ${detail.days} days`
        : "You turned follow-ups off";
    case "digest_settings_saved":
      return detail.enabled
        ? "You changed your morning summary"
        : "You turned the morning summary off";
    case "autopilot_scheduled":
      return `Autopilot lined up a reply${to} — you had time to hold it`;
    case "autopilot_held":
      return `You held an autopilot reply${to}`;
    case "autopilot_stood_down":
      return `Autopilot didn't send the reply${to} — something changed, so it waits for you`;
    case "autopilot_changed":
      return `You turned autopilot ${detail.on ? "on" : "off"}${
        typeof detail.category === "string" && isCategory(detail.category)
          ? ` for ${categoryLabels[detail.category].toLowerCase()}`
          : ""
      }`;
    case "plan_changed":
      return detail.to
        ? `Your plan changed to ${String(detail.to)[0]!.toUpperCase()}${String(detail.to).slice(1)}`
        : "Your plan was removed";
    case "payment_received":
      return detail.includesSetup
        ? "Payment received — setup paid and sending switched on"
        : "Payment received — your plan is back on";
    case "subscription_changed":
      return detail.to === "past_due"
        ? "A payment didn't go through — paused until your card is updated"
        : detail.to === "canceled"
          ? "Your plan ended — nothing was deleted"
          : detail.from === "past_due" || detail.from === "canceled"
            ? "Payment sorted — switched back on"
            : "Your plan was updated";
    case "digest_sent":
      return "Sent your morning summary";
    case "monthly_summary_sent":
      return "Sent your monthly summary";
    case "referral_credit_applied":
      return "A referral credit was added to your account";
    case "test_payment_reset":
      // Only worth saying when it turned sending off; clearing old test ids alone changes nothing
      // the owner can see. No "choose a plan": a paused account can't (checkoutTerms).
      return detail.setupPaymentCleared
        ? "Your test payment was cleared — the setup fee is still due"
        : null;
    case "evaluation_started":
      return `Your ${daysPhrase(pricing.evaluationDays)} started`;
    case "evaluation_expired":
      // The trial may have been extended, so not "three days".
      return "Your trial ended";
    case "workspace_status_changed":
      return detail.to === "setup_paid"
        ? "Setup paid — sending switched on"
        : detail.to === "active"
          ? "Setup finished — your account is active"
          : detail.to === "paused"
            ? "Your account was paused"
            : detail.to === "evaluating"
              ? `Your trial was extended by ${daysPhrase(pricing.evaluationDays)}`
              : "Your account status changed";
    default:
      return null;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-12" → "Oct 12" (a local date stored with the entry). */
function shortDate(ymd: string): string | null {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(ymd);
  const month = m ? MONTHS[Number(m[1]) - 1] : undefined;
  return m && month ? `${month} ${Number(m[2])}` : null;
}

export type ActivityEntry = {
  id: string;
  at: Date;
  text: string;
  byYou: boolean;
  /** Plan #41: a sent reply links to its record. */
  recordId: string | null;
};
const SENT_ACTIONS = new Set(["reply_sent", "reply_sent_from_gmail", "reply_went_to_form"]);

export async function listActivity(workspaceId: string, limit = 100): Promise<ActivityEntry[]> {
  const rows = await db()
    .select()
    .from(activityLog)
    .where(eq(activityLog.workspaceId, workspaceId))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit);

  const threadIds = [...new Set(rows.map((r) => r.threadId).filter((t): t is string => !!t))];
  const who = new Map<string, Who>();
  if (threadIds.length) {
    const cats = await db()
      .select({ id: threads.id, category: threads.category })
      .from(threads)
      .where(inArray(threads.id, threadIds));
    const names = await db()
      // As a reply addresses them: a website form's own name for the customer, never the robot's.
      .select({ threadId: messages.threadId, name: messageReplyName() })
      .from(messages)
      .where(and(inArray(messages.threadId, threadIds), eq(messages.direction, "in")))
      .orderBy(desc(messages.sentAt));
    for (const c of cats) who.set(c.id, { name: null, category: c.category });
    for (const n of names) {
      const w = who.get(n.threadId);
      if (w && !w.name) w.name = n.name;
    }
  }

  return rows.flatMap((r) => {
    const text = describeActivity(
      r.action,
      r.detail,
      r.threadId ? (who.get(r.threadId) ?? null) : null,
    );
    if (!text) return [];
    const recordId =
      SENT_ACTIONS.has(r.action) && typeof r.detail.draftId === "string" ? r.detail.draftId : null;
    return [{ id: r.id, at: r.createdAt, text, byYou: r.actor === "owner", recordId }];
  });
}

export type MonthSummary = {
  sorted: number;
  drafted: number;
  sent: number;
  sentAfterEditing: number;
  nudgesSent: number;
  minutesSaved: number;
};

// The month helpers are pure and live with the other time rules; re-exported for old callers.
export { localMonthName, localMonthStart } from "./snooze-rules";

/** The time zone the month is counted in: the one given, or the owner's from their profile. */
async function monthZone(workspaceId: string, timeZone?: string): Promise<string> {
  return usableTimeZone(timeZone ?? (await workspaceTimeZone(workspaceId)));
}

/** This calendar month (in the owner's time zone), in counts. */
export async function monthSummary(
  workspaceId: string,
  now: Date = new Date(),
  timeZone?: string,
): Promise<MonthSummary> {
  const start = localMonthStart(now, await monthZone(workspaceId, timeZone));
  const boxes = (
    await db()
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.workspaceId, workspaceId))
  ).map((b) => b.id);
  if (boxes.length === 0)
    return { sorted: 0, drafted: 0, sent: 0, sentAfterEditing: 0, nudgesSent: 0, minutesSaved: 0 };

  const [sorted] = await db()
    .select({ n: count() })
    .from(threads)
    .where(and(inArray(threads.mailboxId, boxes), gte(threads.classifiedAt, start)));
  const [made] = await db()
    .select({ n: count() })
    .from(drafts)
    .where(and(inArray(drafts.mailboxId, boxes), gte(drafts.createdAt, start)));
  // Sent is counted by when the owner okayed it (decided_at), like the weekly scorecard, so a
  // draft made last month and sent this month counts here, and the week and the month agree
  // on the days they share (plan M8 A18; a week that started last month also counts last
  // month's days). Drafted stays on when it was made.
  const sentRows = await db()
    .select({ status: drafts.status, kind: drafts.kind })
    .from(drafts)
    .where(
      and(
        inArray(drafts.mailboxId, boxes),
        inArray(drafts.status, ["sent", "edited_and_sent"]),
        gte(drafts.decidedAt, start),
      ),
    );
  const sent = sentRows.length;
  return {
    sorted: sorted?.n ?? 0,
    drafted: made?.n ?? 0,
    sent,
    sentAfterEditing: sentRows.filter((d) => d.status === "edited_and_sent").length,
    nudgesSent: sentRows.filter((d) => d.kind === "followup").length,
    minutesSaved: sent * MINUTES_PER_SENT_REPLY,
  };
}

export type MonthCloseRate = {
  won: number;
  lost: number;
  noAnswer: number;
  /** Won out of all three, as a whole percent; null when nothing was decided. */
  ratePct: number | null;
};

/**
 * Plan #30: quotes decided this calendar month, in the owner's time zone — by when the
 * outcome was set, whoever set it (the owner, or our guess the owner left alone).
 */
export async function monthCloseRate(
  workspaceId: string,
  now: Date = new Date(),
  timeZone?: string,
): Promise<MonthCloseRate> {
  const start = localMonthStart(now, await monthZone(workspaceId, timeZone));
  return closeRateBetween(workspaceId, start, null);
}

/**
 * Quotes decided in [start, end) — by when the outcome was set, whoever set it. `end` null
 * means no upper bound (this month so far); the monthly summary passes last month's bounds.
 */
export async function closeRateBetween(
  workspaceId: string,
  start: Date,
  end: Date | null,
): Promise<MonthCloseRate> {
  const rows = await db()
    .select({ outcome: threads.quoteOutcome, n: count() })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        isNotNull(threads.quoteOutcome),
        gte(threads.quoteOutcomeAt, start),
        end ? lt(threads.quoteOutcomeAt, end) : undefined,
      ),
    )
    .groupBy(threads.quoteOutcome);
  const n = (o: QuoteOutcome) => Number(rows.find((r) => r.outcome === o)?.n ?? 0);
  const c = { won: n("won"), lost: n("lost"), noAnswer: n("no_answer") };
  return { ...c, ratePct: closeRate(c) };
}

/**
 * Outside review K1: this month's money, from what the app already keeps — never from
 * price memory (only the owner's screens may read that). Quotes won = outcome "won" set this
 * month (by the owner, or our guess they left alone) with the amount from their own quote
 * when we have it. Paid after a follow-up = an invoice marked paid this month (by the owner,
 * or our guess) on a thread where a follow-up nudge was sent before it was marked paid.
 */
export async function monthMoney(
  workspaceId: string,
  now: Date = new Date(),
  timeZone?: string,
): Promise<MonthMoney> {
  const start = localMonthStart(now, await monthZone(workspaceId, timeZone));
  const won = await wonSince(workspaceId, start);
  const paid = await db()
    .select({ extracted: threads.extracted })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        gte(threads.invoicePaidAt, start),
        inArray(threads.invoicePaidSource, ["owner", "auto"]),
        sql`exists (
          select 1 from ${drafts}
          where ${drafts.threadId} = ${threads.id}
            and ${drafts.kind} = 'followup'
            and ${drafts.status} in ('sent', 'edited_and_sent')
            and ${drafts.decidedAt} < ${threads.invoicePaidAt}
        )`,
      ),
    );
  return {
    won: tally(won.map((r) => r.cents)),
    paidAfterNudge: tally(paid.map((r) => dollarsToCents(invoiceOf(r.extracted)?.amount))),
  };
}

/** Quotes marked won since `start` (the owner's mark or our guess), with the quoted amount. */
async function wonSince(workspaceId: string, start: Date) {
  return db()
    .select({ cents: threads.quoteAmountCents })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        eq(threads.quoteOutcome, "won"),
        gte(threads.quoteOutcomeAt, start),
      ),
    );
}

/**
 * Replies package (Davi, 2026-10-16): "this month so far" for the morning email and
 * Activity — quotes won (the same rows as "Quotes won" above), invoices paid this month and
 * what's still owed, from Money's own data (`invoiceTotals`). The month is the owner's,
 * in their time zone. Totals only: no name, subject or customer detail leaves here.
 */
export async function moneySoFar(
  workspaceId: string,
  now: Date = new Date(),
  timeZone?: string,
): Promise<MoneySoFar> {
  const start = localMonthStart(now, await monthZone(workspaceId, timeZone));
  const [won, invoices] = await Promise.all([
    wonSince(workspaceId, start),
    invoiceTotals(workspaceId, now, start),
  ]);
  return {
    won: tally(won.map((r) => r.cents)),
    paid: tally(invoices.paidCents),
    owed: { count: invoices.owedCount, cents: invoices.owedCents },
  };
}

/**
 * Ideas C5: why quotes were lost this month (the owner's taps), by `quote_outcome_at` in the
 * owner's month — the same quotes as the month's Lost count. Counts only.
 */
export async function lostReasonsBetween(workspaceId: string, start: Date, end: Date | null) {
  const rows = await db()
    .select({ reason: threads.quoteLostReason, n: count() })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        eq(threads.quoteOutcome, "lost"),
        isNotNull(threads.quoteLostReason),
        gte(threads.quoteOutcomeAt, start),
        end ? lt(threads.quoteOutcomeAt, end) : undefined,
      ),
    )
    .groupBy(threads.quoteLostReason);
  const out: Partial<Record<LostReason, number>> = {};
  for (const r of rows) if (isLostReason(r.reason)) out[r.reason] = Number(r.n);
  return out;
}
