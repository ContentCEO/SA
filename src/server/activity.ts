import "server-only";
import { and, count, desc, eq, gte, inArray, isNotNull, lt } from "drizzle-orm";
import { categoryLabels, categoryTag, isCategory } from "@/config/categories";
import { db } from "@/db";
import { activityLog, drafts, mailboxes, messages, threads } from "@/db/schema";
import { MINUTES_PER_SENT_REPLY } from "@/config/drafting";
import { atRiskActivityLine } from "./leads-at-risk-rules";
import { closeRate, isQuoteOutcome, type QuoteOutcome } from "./quote-rules";
import { referralActivityLine } from "./referral-rules";
import { workspaceTimeZone } from "./snooze";
import { localMonthStart, usableTimeZone } from "./snooze-rules";

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
  timeZone?: string | null,
): string | null {
  // Plan #47 free months and the plan effects that come with them (dates in the owner's zone).
  const referral = referralActivityLine(action, detail, timeZone);
  if (referral) return referral;
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
    case "draft_revised":
      return detail.via === "voice"
        ? `You changed the draft${to} by voice`
        : `You changed the draft${to} with a quick tweak`;
    case "practice_sent":
      return `You sent yourself a practice copy of the reply${to} — they got nothing`;
    case "send_undone":
      return `You stopped the reply${to} before it went`;
    case "send_stopped":
      // A paused inbox's drafts are off the queue, so this one never says "back in your queue".
      if (detail.why === "inbox_paused")
        return `Didn't send the reply${to} — that inbox is paused (your plan's inboxes are all in use). It's still in that inbox's Gmail drafts`;
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
      return "Your three days started";
    case "evaluation_expired":
      return "Your three days ended";
    case "workspace_status_changed":
      return detail.to === "setup_paid"
        ? "Setup paid — sending switched on"
        : detail.to === "active"
          ? "Setup finished — your account is active"
          : detail.to === "paused"
            ? "Your account was paused"
            : detail.to === "evaluating"
              ? "Your three days were extended"
              : "Your account status changed";
    default:
      return null;
  }
}

export type ActivityEntry = {
  id: string;
  at: Date;
  text: string;
  byYou: boolean;
  /** Plan #41: a sent reply links to its record. */
  recordId: string | null;
};
const SENT_ACTIONS = new Set(["reply_sent", "reply_sent_from_gmail"]);

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
      .select({ threadId: messages.threadId, name: messages.fromName })
      .from(messages)
      .where(and(inArray(messages.threadId, threadIds), eq(messages.direction, "in")))
      .orderBy(desc(messages.sentAt));
    for (const c of cats) who.set(c.id, { name: null, category: c.category });
    for (const n of names) {
      const w = who.get(n.threadId);
      if (w && !w.name) w.name = n.name;
    }
  }

  const zone = rows.some((r) => !r.threadId) ? await workspaceTimeZone(workspaceId) : null;
  return rows.flatMap((r) => {
    const text = describeActivity(
      r.action,
      r.detail,
      r.threadId ? (who.get(r.threadId) ?? null) : null,
      zone,
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
