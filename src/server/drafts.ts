import "server-only";
import { MAX_FOLLOWUPS } from "@/config/rules";
import { needsOwnerBlocksNudge } from "./followup-rules";
import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { callStructured } from "@/ai/client";
import {
  checkDraft,
  claimsHuman,
  hasLink,
  REGENERATE_ON,
  type CheckResult,
} from "@/ai/draft-checks";
import { asksWhenAvailable, spellDate } from "@/ai/when-words";
import { licenseFacts } from "@/config/licenses";
import { injectionCheck, looksLikePaymentChange } from "@/ai/guards";
import {
  REVISE_INSTRUCTIONS,
  REVISE_PROMPT_VERSION,
  reviseTask,
  TWEAKS,
  type Tweak,
} from "@/ai/prompts/revise.v2";
import { MAX_REVISIONS_PER_DRAFT, UNDO_WINDOW_SECONDS } from "@/config/drafting";
import { findGaps, hasUnfilledGap } from "@/ai/gaps";
import {
  conversationBlock,
  DRAFT_INSTRUCTIONS,
  DRAFT_PROMPT_VERSION,
  draftSchema,
  FIRST_CONTACT_TASK,
  replyDraftSchema,
  workspaceBlock,
  type ModelDraft,
  type Opening,
  type WorkspaceContext,
} from "@/ai/prompts/draft.v8";
import {
  OPENING_TWEAKS,
  OPENING_TWEAKS_PROMPT_VERSION,
  type OpeningTweak,
} from "@/ai/prompts/opening-tweaks.v1";
import { DISPUTE_REASONS, prepareBody } from "@/ai/classify";
import {
  DISPUTE_CAUTION_PROMPT_VERSION,
  DISPUTE_CONFIDENCE_CAP,
  DISPUTE_FLAG,
  DISPUTE_TASK,
} from "@/ai/prompts/dispute-caution.v1";
import {
  FOLLOWUP_INSTRUCTIONS,
  FOLLOWUP_PROMPT_VERSION,
  followupTask,
} from "@/ai/prompts/followup.v4";
import {
  closingQuestionTask,
  depositTask,
  PURPOSE_PROMPT_VERSION,
  reviewRequestTask,
  thankYouTask,
} from "@/ai/prompts/purpose.v2";
import {
  ensureDepositGap,
  isQuoteAcceptance,
  NO_PAYMENT_TERMS_FLAG,
  PURPOSE_FLAG_CONFIDENCE_CAP,
  REVIEW_LINK_MISSING_FLAG,
} from "@/ai/purpose";
import { AiCapReachedError, bumpUsageCounter } from "@/ai/usage";
import { featureOn } from "@/config/features";
import { mailboxOn } from "./mailbox-plan-rules";
import { mailboxRunning } from "./mailbox-plan";
import { activeNotes } from "./seasonal-notes";
import { db } from "@/db";
import {
  activityLog,
  businessProfiles,
  drafts,
  mailboxes,
  messages,
  THANK_YOU_PURPOSES,
  threads,
  voiceProfiles,
  workspaces,
  type Draft,
  type DraftPurpose,
  type Mailbox,
} from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import {
  MailboxAuthError,
  MailboxRateLimitError,
  type MailboxReader,
  type MailboxWriter,
} from "@/mailbox/connector";
import { createGmailReader } from "@/mailbox/gmail/api";
import { gmailThreadLink } from "@/lib/gmail-link";
import { staleTiming, type StaleTiming } from "./draft-timing";
import { workspaceTimeZone } from "./snooze";
import { buildReplyMime, replySubject, sameText, toGmailRaw } from "@/mailbox/mime";
import {
  canSend,
  effectiveStatus,
  jobsAllowed,
  ReadOnlyError,
  SendingBlockedError,
} from "./lifecycle";
import { batchEligible, firstLine } from "./batch-rules";
import { isInvoiceThread, paymentSaid } from "./money-rules";
import { quoteStopsNudges } from "./quote-rules";
import { BACK_ON_TOP_MS, isEmergency } from "./snooze-rules";
import { inEmergencyLane, recentEmergency } from "./emergency-rules";
import { CHECKIN_AFTER_DAYS, CHECKIN_MAX_DAYS } from "./complaint-rules";
import { headerPickIds, toNeedsYouItem } from "./digest-rules";
import { answeredByPhone } from "./first-week-rules";
import {
  asDate,
  messageReplyAddress,
  messageReplyName,
  noReplySql,
  notDraftMessage,
  notDraftSql,
  replyAddressSql,
  sideEmailSql,
  waitingSinceSql,
  answeredByPhoneSql,
} from "./thread-sql";
import {
  closingQuestionAllowed,
  recentReviewAddresses,
  reviewAllowed,
  thankYouAllowed,
} from "./offers";
import { lockReviewAddress } from "./review-lock";
import { markReconnectNeeded, recordSentMessage } from "./sync";
import { readReplyTo, workspaceMailboxEmails } from "./reply-address";
import {
  customerReplyAddress,
  customerReplyName,
  NO_REPLY_FLAG,
  REPOINTED_FLAG,
  type ReplyToHeader,
} from "./reply-address-rules";
import { isNoReplyAddress } from "./sender-rules";
import { noDraftRuleFor } from "./sender-rule-store";
import { isAway } from "./away";
import {
  channelKind,
  channelOf,
  isEmailToTextAddress,
  looksLikePhoneAddress,
} from "./channel-rules";
import { knownCustomer, ownerWroteBefore } from "./known-customer";
import { isFirstContact, isFirstContactOpening, storedOpening } from "./first-contact-rules";

/** Categories we draft for without being asked. Complaints and noise never are. */
export const AUTO_DRAFT_CATEGORIES = [
  "quote_request",
  "customer_question",
  "scheduling",
  "invoice_payment",
  "supplier_vendor",
] as const;
/** Quiet threads in these categories get nudged. */
export const FOLLOWUP_CATEGORIES = ["quote_request", "invoice_payment"] as const;
/** Nudges per thread, ever (src/config/rules.ts, where the homepage reads it too). */
export { MAX_FOLLOWUPS };
const CONVERSATION_MESSAGES = 6;
const PER_MESSAGE_CHARS = 3_000;

export type DraftDeps = {
  writerFor?: (m: Mailbox) => MailboxWriter;
  /** Reads a stored email's Reply-To when sync never did (defaults to the writer's client). */
  readerFor?: (m: Mailbox) => Pick<MailboxReader, "getMessage">;
  now?: () => Date;
  /** Check 48 P4: the owner is waiting on this tap (shorter model time limit). */
  aiMode?: "interactive" | "job";
};

export const defaultWriter = (m: Mailbox) =>
  createGmailReader({ refreshToken: decryptSecret(m.encryptedRefreshToken) });

export type CreateOutcome =
  | { status: "created"; draftId: string }
  | {
      status: "skipped";
      reason:
        | "not_found"
        | "mailbox_inactive"
        | "noise"
        | "needs_owner"
        | "category"
        | "already_pending"
        | "owner_replied_last"
        | "no_text"
        | "capped"
        | "model_failed"
        | "read_only"
        | "followup_not_allowed"
        | "wait_requested"
        | "customer_replied"
        | "followup_cap"
        | "untrusted"
        | "municipal"
        // Round 2: asks to pay a new account (A11) — only the owner's tap drafts one.
        | "payment_change"
        /** Check 48 P1: "is this a bot?" — only the owner's tap drafts it. */
        | "asks_if_ai"
        // Round 2 (FW E11): the owner said they called after the newest email.
        | "answered_by_phone"
        // Purpose drafts (plan #26 #28 #29). S6 adds the per-purpose eligibility reasons.
        | "purpose_not_allowed"
        | "feature_off"
        | "already_asked"
        | "no_review_link"
        | "review_recent"
        | "complaint"
        | "not_eligible"
        // Reply-To (review B1): the reply would go to a no-reply address (jobs and offers
        // only — the owner's own "Draft a reply" gets a flagged draft instead), or Gmail
        // couldn't tell us where it goes (never guessed: no draft).
        | "no_reply_address"
        | "gmail_busy"
        | "reply_to_unread"
        // Ideas H3: the owner's "Never draft" rule for this sender (jobs only).
        | "sender_rule"
        // Ideas H4: the owner chose this kind; the sorter wouldn't have drafted it (jobs only).
        | "owner_moved"
        // Ideas E7: nudges pause while the owner is away.
        | "away"
        // Leads package: the reply would go to an email-to-text gateway (it would text the
        // customer) — every trigger; or to an address that looks like a phone number the owner
        // never wrote to (jobs only; the owner's tap gets MAYBE_TEXT_FLAG instead).
        | "text_address"
        | "maybe_text_address"
        // A lead website's notice or a voicemail / text-message email: answered on the site
        // or from the owner's own phone, never by email (every trigger).
        | "lead_site"
        | "phone_message"
        // The plan covers fewer Gmail addresses and this one is paused (2026-10-16): no draft,
        // no model call, whoever asked.
        | "mailbox_paused";
    }
  | { status: "reconnect_needed" };

async function loadThread(threadId: string) {
  const [row] = await db()
    .select({ thread: threads, mailbox: mailboxes, workspace: workspaces })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(eq(threads.id, threadId));
  return row;
}

/**
 * Purposes only the owner's tap may ask for. Deposit is never asked for: it's derived (#28).
 * "thank_you" (2026-10-16) is stored as `thank_you` or `thank_you_review`: the server decides
 * whether the review ask goes in.
 */
export const OWNER_PURPOSES = ["review_request", "closing_question", "thank_you"] as const;

/** A thank-you note, with or without the review ask in it. */
export const isThankYou = (p: string | null | undefined): p is "thank_you" | "thank_you_review" =>
  (THANK_YOU_PURPOSES as readonly (string | null | undefined)[]).includes(p);

/** A note that asks the customer for a review: counts toward the one-a-year limit. */
const asksForReview = (p: string | null | undefined) =>
  p === "review_request" || p === "thank_you_review";

/** Round 2 (TW B4): the fixed safety note's "prompt version" — code, never a model. */
export const SAFETY_NOTE_VERSION = "safety-note.v1";
/** Leads package: the owner's tap on a reply whose address looks like a phone number. */
export const MAYBE_TEXT_FLAG =
  "This address looks like a phone number — it may turn into a text message. Check before sending.";
/** What a refused email-to-text draft says when it's closed (leads package). */
export const TEXT_ADDRESS_NOTE =
  "That address turns email into a text message, and Squared Away never texts customers. Text them from your own phone instead.";
/** First flag on the safety note: it keeps it out of batch and autopilot too. */
export const SAFETY_NOTE_FLAG =
  "They say they smell gas. Call them now; this note only tells them what to do meanwhile.";
/** Check 22 P4: the carbon monoxide note's own "prompt version" (code, never a model). */
export const CO_SAFETY_NOTE_VERSION = "safety-note-co.v1";
/** First flag on the carbon monoxide note (keeps it out of batch and autopilot). */
export const CO_SAFETY_NOTE_FLAG =
  "They say a carbon monoxide alarm went off. Call them now; this note only tells them what to do meanwhile.";

/** Check 37 P1: the electrical safety note's own "prompt version" (code, never a model). */
export const ELECTRICAL_SAFETY_NOTE_VERSION = "safety-note-electrical.v1";
/** First flag on the electrical note (keeps it out of batch and autopilot). */
export const ELECTRICAL_SAFETY_NOTE_FLAG =
  "Sounds like an electrical fire risk. Call them now; this note only tells them what to do meanwhile.";

/** Which fixed safety note a thread's marks call for, if any (gas, then CO, then electrical). */
export type SafetyKind = "gas" | "co" | "electrical";
export function safetyKindOf(marks: {
  gas_smell?: unknown;
  co_alarm?: unknown;
  electrical_hazard?: unknown;
}): SafetyKind | null {
  if (marks.gas_smell === true) return "gas";
  if (marks.co_alarm === true) return "co";
  if (marks.electrical_hazard === true) return "electrical";
  return null;
}

const SAFETY_NOTES: Record<
  SafetyKind,
  {
    version: string;
    flag: string;
    note: (ctx: Pick<WorkspaceContext, "signature" | "businessName">) => ModelDraft;
  }
> = {
  gas: { version: SAFETY_NOTE_VERSION, flag: SAFETY_NOTE_FLAG, note: (c) => safetyNote(c) },
  co: { version: CO_SAFETY_NOTE_VERSION, flag: CO_SAFETY_NOTE_FLAG, note: (c) => coSafetyNote(c) },
  electrical: {
    version: ELECTRICAL_SAFETY_NOTE_VERSION,
    flag: ELECTRICAL_SAFETY_NOTE_FLAG,
    note: (c) => electricalSafetyNote(c),
  },
};

/**
 * The fixed safety note for a gas smell (TW B4). Plain, no prices, no times, nothing invented:
 * what anyone should do while they wait. The owner reads it and taps Send reply, or not.
 */
export function safetyNote(ctx: Pick<WorkspaceContext, "signature" | "businessName">): ModelDraft {
  const sign = ctx.signature?.trim() || ctx.businessName?.trim() || "";
  return {
    body: [
      "Hi,",
      "",
      "If you smell gas right now, please don't wait on email. Get everyone out of the house, don't switch lights or anything electric on or off, and don't light anything. Once you're outside, call your gas company's emergency line or 911.",
      "",
      "I'll call you as soon as I can.",
      ...(sign ? ["", sign] : []),
    ].join("\n"),
    reason: "They smell gas. A safety note is ready; call them too.",
    flags: [],
    confidence: 0.5,
    used_facts: sign && ctx.signature?.trim() ? ["signature"] : [],
  };
}

/**
 * Check 22 P4: the fixed note for a carbon monoxide alarm. The usual fire-safety advice: get
 * out to fresh air, call 911 from outside, don't go back in until the fire department says so.
 * Wording waits on Davi's okay (see docs/notes). No model, nothing invented.
 */
export function coSafetyNote(
  ctx: Pick<WorkspaceContext, "signature" | "businessName">,
): ModelDraft {
  const sign = ctx.signature?.trim() || ctx.businessName?.trim() || "";
  return {
    body: [
      "Hi,",
      "",
      "If your carbon monoxide alarm is going off, please don't wait on email. Get everyone out of the house into fresh air right away, pets too, and call 911 from outside. Don't go back in until the fire department says it's safe.",
      "",
      "I'll call you as soon as I can.",
      ...(sign ? ["", sign] : []),
    ].join("\n"),
    reason: "Their carbon monoxide alarm went off. A safety note is ready; call them too.",
    flags: [],
    confidence: 0.5,
    used_facts: sign && ctx.signature?.trim() ? ["signature"] : [],
  };
}

/**
 * Check 37 P1: the fixed note for electrical fire signs, from the usual electrical safety advice
 * (warm outlets, a burning smell and sparks mean call an electrician; fire means 911). Wording
 * waits on Davi's okay (see docs/notes). No model, nothing invented.
 */
export function electricalSafetyNote(
  ctx: Pick<WorkspaceContext, "signature" | "businessName">,
): ModelDraft {
  const sign = ctx.signature?.trim() || ctx.businessName?.trim() || "";
  return {
    body: [
      "Hi,",
      "",
      "If you see smoke or flames, get everyone out and call 911 from outside. If it's safe to reach your panel, switch off the breaker for that area and don't use that outlet or switch until we've looked at it. If wires are down outside, stay well away and call your electric company.",
      "",
      "I'll call you as soon as I can.",
      ...(sign ? ["", sign] : []),
    ].join("\n"),
    reason: "Sounds like an electrical fire risk. A safety note is ready; call them too.",
    flags: [],
    confidence: 0.5,
    used_facts: sign && ctx.signature?.trim() ? ["signature"] : [],
  };
}

/** Whether a draft with this purpose was ever written on the thread (any status). */
async function purposeOnThread(threadId: string, purpose: DraftPurpose): Promise<boolean> {
  const [row] = await db()
    .select({ id: drafts.id })
    .from(drafts)
    .where(and(eq(drafts.threadId, threadId), eq(drafts.purpose, purpose)))
    .limit(1);
  return !!row;
}
export type OwnerPurpose = (typeof OWNER_PURPOSES)[number];

/** Nudges actually sent in this thread (from the app or from Gmail). Discarded ones don't count. */
export async function countSentFollowups(threadId: string): Promise<number> {
  const rows = await db()
    .select({ id: drafts.id })
    .from(drafts)
    .where(
      and(
        eq(drafts.threadId, threadId),
        eq(drafts.kind, "followup"),
        inArray(drafts.status, ["sent", "edited_and_sent"]),
      ),
    );
  return rows.length;
}

/**
 * A deposit, review request or closing question went out on this thread (A3). After that
 * the thread is never nudged: the customer accepted, was thanked, or was asked once already.
 * A deposit note only stops the QUOTE's nudges: once the thread is about an invoice
 * (`invoiceThread`, isInvoiceThread), the won job's invoice is still chased.
 */
export async function purposeSentOn(
  threadId: string,
  opts: { invoiceThread?: boolean } = {},
): Promise<boolean> {
  const [row] = await db()
    .select({ id: drafts.id })
    .from(drafts)
    .where(
      and(
        eq(drafts.threadId, threadId),
        isNotNull(drafts.purpose),
        opts.invoiceThread ? sql`${drafts.purpose} <> 'deposit'` : undefined,
        inArray(drafts.status, ["sent", "edited_and_sent"]),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Why a quiet thread is never nudged, apart from the outcome and paid marks: the customer's
 * newest email said they paid (we may not have marked it — a deposit is not the job being
 * paid — but they aren't chased right after paying), or a purpose note went out (A3).
 */
async function nudgeBlocked(thread: {
  id: string;
  category: string | null;
  extracted: unknown;
}): Promise<boolean> {
  if (paymentSaid(thread.extracted) === "paid") return true;
  return purposeSentOn(thread.id, { invoiceThread: isInvoiceThread(thread) });
}

/**
 * A deposit note was drafted on this thread and the owner saw it through: sent, still
 * waiting, or discarded (the owner may have sent the deposit details from Gmail themselves).
 * A customer who writes again ("Great. When can you start?") often reads as another
 * acceptance; they get an ordinary reply, never a second request for the deposit. An
 * `expired` one doesn't count: it went stale because the customer wrote again before the
 * owner tapped anything, so the deposit request is drafted afresh.
 */
async function depositAlreadyOn(threadId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: drafts.id })
    .from(drafts)
    .where(
      and(
        eq(drafts.threadId, threadId),
        eq(drafts.purpose, "deposit"),
        inArray(drafts.status, ["pending", "sent", "edited_and_sent", "discarded"]),
      ),
    )
    .limit(1);
  return !!row;
}

export async function followupSettings(workspaceId: string) {
  const [p] = await db()
    .select({ enabled: businessProfiles.followupsEnabled, days: businessProfiles.followupDays })
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId));
  return { enabled: p?.enabled ?? true, days: p?.days ?? 3 };
}

/**
 * The customer in a thread: whoever most recently wrote in, as the reply would address them
 * (a website form's Reply-To, else the sender).
 */
async function customerOf(threadId: string) {
  const [m] = await db()
    .select({
      fromName: messages.fromName,
      fromAddress: messages.fromAddress,
      replyToHeader: messages.replyToHeader,
    })
    .from(messages)
    .where(and(eq(messages.threadId, threadId), eq(messages.direction, "in")))
    .orderBy(desc(messages.sentAt))
    .limit(1);
  return m ? { name: customerReplyName(m), address: customerReplyAddress(m) } : null;
}

/** A reader for a stored email's Reply-To: the one given, else the Gmail client itself. */
function replyReader(
  mailbox: Mailbox,
  opts: Pick<DraftDeps, "readerFor" | "writerFor">,
): Pick<MailboxReader, "getMessage"> | null {
  if (opts.readerFor) return opts.readerFor(mailbox);
  const w = (opts.writerFor ?? defaultWriter)(mailbox) as Partial<MailboxReader>;
  return typeof w.getMessage === "function" ? (w as Pick<MailboxReader, "getMessage">) : null;
}

type DraftContext = WorkspaceContext & {
  reviewUrl: string | null;
  /** The owner's time zone, for "Today is…" and each email's time (review A8). */
  timeZone: string | null;
  /** Check 38 P2: the owner's two-letter state, for the Massachusetts deposit rule. */
  state?: string | null;
};

/**
 * The terms check for deposit and review notes (A4). Percentages, amounts, ways to pay and
 * anything offered must come from the owner: their written terms, or what they wrote this customer
 * themselves. Never from the customer's emails — "can I pay by Venmo?" isn't a yes.
 * A review request has no terms to draw on: it never mentions payment or offers anything.
 */
function termsCheck(
  purpose: DraftPurpose | null,
  ctx: DraftContext,
  owner: { wrote: (string | null)[]; terms?: (string | null)[] },
) {
  if (purpose !== "deposit" && purpose !== "review_request" && !isThankYou(purpose)) return {};
  const join = (xs: (string | null | undefined)[]) => xs.filter(Boolean).join("\n");
  return {
    checkTerms: true,
    termsSource:
      purpose === "deposit"
        ? join([
            ctx.paymentTerms,
            ctx.policies,
            ctx.pricingNotes,
            ...ctx.seasonalNotes.map((n) => n.text),
            ...(owner.terms ?? []),
          ])
        : "",
    ownerWrote: purpose === "deposit" ? join(owner.wrote) : "",
    // A thank-you (2026-10-16) is checked like a review request: nothing offered, no way to pay,
    // no amount, and no link but the review link — none at all when it carries no review ask.
    review:
      purpose === "review_request" || purpose === "thank_you_review"
        ? { url: ctx.reviewUrl }
        : purpose === "thank_you"
          ? { url: null }
          : undefined,
  };
}

/** Check 23 P5: the owner's written terms — payment terms, policies and price list. */
function ownerTerms(ctx: DraftContext): string {
  return [ctx.paymentTerms, ctx.policies, ctx.pricingNotes].filter(Boolean).join("\n");
}

/**
 * Where a day, date or time in a draft may come from (Check 20 P1, Check 23 P3 + P4): the
 * conversation (both sides), seasonal notes with their end dates ("November 27"), and what the
 * owner said for this draft. The hours and lead time go apart: the hours' times always count,
 * their days only when `allowHours`; only the lead time's own "two weeks out" counts.
 */
function whenContext(
  ctx: DraftContext,
  conversation: { m: { direction: string; sentAt: Date }; text: string }[],
  ownerSaid: (string | null | undefined)[],
  now: Date,
  allowHours: boolean,
) {
  return {
    whenSourceText: [
      ...conversation.map((x) => x.text),
      ...ctx.seasonalNotes.flatMap((n) => [n.text, spellDate(n.endsOn)]),
      ...ownerSaid,
    ]
      .filter(Boolean)
      .join("\n"),
    hoursText: ctx.hours,
    leadTimeText: ctx.leadTime,
    allowHours,
    customerMessages: conversation
      .filter((x) => x.m.direction === "in")
      .map((x) => ({ text: x.text, sentAt: x.m.sentAt })),
    now,
    timeZone: ctx.timeZone,
  };
}

/**
 * What a purpose note needs after every model call — a new draft or a tweak alike, so a
 * rewrite can never drop it: a deposit with no payment terms always carries the deposit gap
 * (the send gate holds until it's filled), and a review request must still carry the link.
 */
function purposeGuards(purpose: DraftPurpose | null, body: string, ctx: DraftContext) {
  const flags: string[] = [];
  if (purpose === "deposit" && !ctx.paymentTerms?.trim()) {
    body = ensureDepositGap(body);
    flags.push(NO_PAYMENT_TERMS_FLAG);
  }
  if (asksForReview(purpose) && !(ctx.reviewUrl && hasLink(body, ctx.reviewUrl))) {
    flags.push(REVIEW_LINK_MISSING_FLAG);
  }
  return { body, flags };
}

/**
 * Flags and confidence (0–100) for a finished draft. Purpose flags go first, so the cut to six
 * can't drop them, and they cap confidence on their own (A6).
 */
function scoreDraft(
  result: { flags: string[]; confidence: number },
  checks: CheckResult,
  purposeFlags: string[],
) {
  const flags = [
    ...new Set([
      ...purposeFlags,
      ...result.flags.map((f) => f.trim()).filter(Boolean),
      ...checks.flags,
    ]),
  ].slice(0, 6);
  const confidence = Math.round(
    Math.max(
      0,
      Math.min(
        1,
        result.confidence,
        checks.confidenceCap,
        purposeFlags.length ? PURPOSE_FLAG_CONFIDENCE_CAP : 1,
      ),
    ) * 100,
  );
  return { flags, confidence };
}

/**
 * Everything the drafter knows about the business. `reviewUrl` rides along for the review
 * request task only; it is never part of the cached business block.
 */
export async function workspaceContext(
  workspaceId: string,
  ws: { businessName: string | null; trade: string | null; extraTrades?: string[] | null },
  now: Date = new Date(),
): Promise<DraftContext> {
  const [profile] = await db()
    .select()
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId));
  const [voice] = await db()
    .select()
    .from(voiceProfiles)
    .where(eq(voiceProfiles.workspaceId, workspaceId));
  const ctx: WorkspaceContext = {
    businessName: ws.businessName,
    trade: ws.trade,
    extraTrades: ws.extraTrades ?? [],
    services: profile?.services ?? null,
    serviceArea: profile?.serviceArea ?? null,
    hours: profile?.hours ?? null,
    leadTime: profile?.leadTime ?? null,
    pricingNotes: profile?.pricingNotes ?? null,
    paymentTerms: profile?.paymentTerms ?? null,
    policies: profile?.policies ?? null,
    signature: profile?.signature ?? null,
    doNotPromise: profile?.doNotPromise ?? [],
    neverSay: profile?.neverSay ?? [],
    // Check 38 P6: the saved registration and license numbers.
    licenses: profile?.licenses ?? {},
    seasonalNotes: (await activeNotes(workspaceId, now)).map(({ text, endsOn }) => ({
      text,
      endsOn,
    })),
    voice:
      voice?.status === "ready"
        ? {
            summary: voice.summary,
            greetingStyle: voice.greetingStyle,
            signoffStyle: voice.signoffStyle,
            avgLengthWords: voice.avgLengthWords,
            formality: voice.formality,
            phrasesUsed: voice.phrasesUsed,
            phrasesAvoided: voice.phrasesAvoided,
            examples: voice.examples,
          }
        : null,
  };
  return {
    ...ctx,
    reviewUrl: profile?.reviewUrl ?? null,
    timeZone: profile?.timeZone ?? null,
    state: profile?.state ?? null,
  };
}

/**
 * Write a reply for a thread and save it as a real Gmail draft in the right
 * conversation. `trigger: "auto"` follows the rules (never noise, complaints,
 * or anything that needs the owner); `trigger: "owner"` is the owner asking
 * from the Inbox, which can draft anything that has text to reply to.
 *
 * Purpose drafts (plan #26 #28 #29) are ordinary replies with `drafts.purpose` set: a
 * deposit draft is written, whatever the trigger, when the newest email accepts a quote
 * the owner gave; a review request or closing question only when the owner taps for one.
 */
export async function createDraftForThread(
  threadId: string,
  opts: DraftDeps & {
    /** auto: reply to new mail. owner: they asked. followup: nudge a quiet thread. */
    trigger: "auto" | "owner" | "followup";
    ownerNote?: string | null;
    /** Required when the owner triggers it: the thread must belong to them. */
    workspaceId?: string;
    /** A special note only the owner's tap may ask for. */
    purpose?: OwnerPurpose;
  } = { trigger: "auto" },
): Promise<CreateOutcome> {
  const now = opts.now?.() ?? new Date();
  const row = await loadThread(threadId);
  if (!row) return { status: "skipped", reason: "not_found" };
  if (opts.trigger === "owner" && row.workspace.id !== opts.workspaceId) {
    return { status: "skipped", reason: "not_found" };
  }
  const { thread, mailbox, workspace } = row;
  if (!jobsAllowed(workspace, now)) return { status: "skipped", reason: "read_only" };
  if (mailbox.planPausedAt) return { status: "skipped", reason: "mailbox_paused" };
  if (mailbox.status !== "active") return { status: "skipped", reason: "mailbox_inactive" };
  // A lead website's notice or a voicemail / text-message email (leads package): there is
  // nobody to email. Answered on the site or from the owner's own phone — every trigger,
  // before any Gmail read or model call.
  const leadKind = channelKind(thread.leadChannel);
  if (leadKind === "site") return { status: "skipped", reason: "lead_site" };
  if (leadKind) return { status: "skipped", reason: "phone_message" };
  // "I called them" after the customer's newest email (round 2, FW E11): a job writes nothing
  // (no reply, no nudge) until they write again. The owner's own tap still drafts.
  if (opts.trigger !== "owner" && thread.handledOfflineAt) {
    const [newestIn] = await db()
      .select({ at: messages.sentAt })
      .from(messages)
      .where(and(eq(messages.threadId, threadId), eq(messages.direction, "in")))
      .orderBy(desc(messages.sentAt))
      .limit(1);
    if (answeredByPhone(thread.handledOfflineAt, newestIn?.at ?? null))
      return { status: "skipped", reason: "answered_by_phone" };
  }
  // Review requests and closing questions come from the owner's tap, never a job.
  if (
    opts.purpose !== undefined &&
    (opts.trigger !== "owner" || !(OWNER_PURPOSES as readonly string[]).includes(opts.purpose))
  ) {
    return { status: "skipped", reason: "purpose_not_allowed" };
  }
  // Plan #26 waits on Davi: off unless FEATURE_CLOSING_QUESTION is on.
  if (opts.purpose === "closing_question" && !featureOn("closingQuestion")) {
    return { status: "skipped", reason: "feature_off" };
  }
  // The same rules as the buttons, checked here before any model call whatever the screen
  // showed (plan #29 #26): never a complaint, a known customer with a finished job, once a
  // year per address; the closing question only after both nudges and a quiet week, once ever.
  if (opts.purpose === "review_request") {
    const why = await reviewAllowed(workspace.id, threadId, now);
    if (why) return { status: "skipped", reason: why };
  }
  if (opts.purpose === "closing_question") {
    const why = await closingQuestionAllowed(workspace.id, threadId, now);
    if (why) return { status: "skipped", reason: why };
  }
  // "Say thanks" on a paid invoice (2026-10-16): a paid mark, a real customer, once per thread;
  // the review ask goes in only when every review-request rule allows one for this customer.
  let thankWithReview = false;
  if (opts.purpose === "thank_you") {
    const ok = await thankYouAllowed(workspace.id, threadId, now);
    if (ok.why) return { status: "skipped", reason: ok.why };
    thankWithReview = ok.withReview;
  }

  const marks = (thread.extracted ?? {}) as {
    municipal?: boolean;
    injection?: boolean;
    payment_change?: boolean;
    gas_smell?: boolean;
    co_alarm?: boolean;
    electrical_hazard?: boolean;
    asks_if_ai?: boolean;
    bill_direction?: string;
    model_category?: string;
  };
  // Only the owner's tap drafts for these (feature plan #17, #42; round 2 A11) — never a job.
  if (opts.trigger !== "owner") {
    if (marks.injection) return { status: "skipped", reason: "untrusted" };
    if (marks.municipal) return { status: "skipped", reason: "municipal" };
    if (marks.payment_change) return { status: "skipped", reason: "payment_change" };
    // Check 48 P1 + 43 P2: "is this a bot?" — the owner answers it (their tap drafts it).
    if (marks.asks_if_ai) return { status: "skipped", reason: "asks_if_ai" };
    // Ideas H4: a kind the owner chose feeds a job's draft only when the sorter's own kind
    // would have been drafted too ("out of Junk" on something it called junk is a tap only).
    if (
      thread.categoryManual &&
      !(AUTO_DRAFT_CATEGORIES as readonly string[]).includes(marks.model_category ?? "")
    )
      return { status: "skipped", reason: "owner_moved" };
    // Ideas H3: "Never draft" for this sender — read live, on the customer's newest email (a
    // crew member's reply to a forward never decides it).
    const [newestCustomer] = await db()
      .select({ fromAddress: messages.fromAddress, replyToHeader: messages.replyToHeader })
      .from(messages)
      .where(
        and(
          eq(messages.threadId, threadId),
          eq(messages.direction, "in"),
          sql`not ${sideEmailSql("messages")}`,
        ),
      )
      .orderBy(desc(messages.sentAt))
      .limit(1);
    if (newestCustomer && (await noDraftRuleFor(workspace.id, newestCustomer)))
      return { status: "skipped", reason: "sender_rule" };
    // Ideas E7: nudges wait until the owner is back.
    if (opts.trigger === "followup" && (await isAway(workspace.id, now)))
      return { status: "skipped", reason: "away" };
  }
  // Round 2 (TW B4): someone smells gas. A job writes one fixed safety note (no model), once
  // per thread, and it waits for the owner's tap like everything else. After that the thread
  // is the owner's, as any needs-you email is.
  // Check 22 P4: a carbon monoxide alarm gets its own fixed note, the same way.
  const safetyKind = safetyKindOf(marks);
  const safety =
    opts.trigger === "auto" &&
    safetyKind !== null &&
    opts.purpose === undefined &&
    !(await purposeOnThread(threadId, "safety"));
  if (opts.trigger === "auto" && !safety) {
    if (thread.category === "noise") return { status: "skipped", reason: "noise" };
    if (thread.needsOwner) return { status: "skipped", reason: "needs_owner" };
    if (
      !AUTO_DRAFT_CATEGORIES.includes(thread.category as (typeof AUTO_DRAFT_CATEGORIES)[number])
    ) {
      return { status: "skipped", reason: "category" };
    }
  }
  const followup = opts.trigger === "followup";
  let nudgeNumber: 1 | 2 = 1;
  if (followup) {
    // Checked here, where the draft is made, whatever selected the thread.
    if (
      // Check 12 P1: "needs you" stops it, unless it's only an invoice's size.
      needsOwnerBlocksNudge(thread) ||
      // A decided quote (lost / no answer, any source; won, unless it's now the job's
      // invoice) is never chased.
      quoteStopsNudges(thread) ||
      // Nor a paid invoice (the owner's mark or our guess) or one that isn't owed (#27).
      thread.invoicePaidAt != null ||
      // Nor a bill the owner has to pay: a supplier's statement is never chased (TW A2).
      marks.bill_direction === "owed_by_business" ||
      !FOLLOWUP_CATEGORIES.includes(thread.category as (typeof FOLLOWUP_CATEGORIES)[number]) ||
      // Nor a thread where a deposit, review request or closing question went out (A3) —
      // a deposit only while it's a quote — or whose customer just said they paid.
      (await nudgeBlocked(thread))
    ) {
      return { status: "skipped", reason: "followup_not_allowed" };
    }
    // Check 21 P2: they asked us to wait ("after the holidays"): not before that day.
    if (thread.nudgeAfter && thread.nudgeAfter.getTime() > now.getTime())
      return { status: "skipped", reason: "wait_requested" };
    const sentNudges = await countSentFollowups(threadId);
    if (sentNudges >= MAX_FOLLOWUPS) return { status: "skipped", reason: "followup_cap" };
    nudgeNumber = sentNudges === 0 ? 1 : 2;
  }
  // Check 38 P1: the newest email approves a change order on a job already won.
  const changeOrder = changeOrderApproved(thread);
  // The owner's purpose, or deposit details when the newest email accepts the quote (#28, A5).
  // Only once per thread: after a deposit note was drafted (whatever became of it), or when
  // the email itself says it paid ("Sent the deposit, when can you start?"), it is answered
  // as an ordinary reply.
  let purpose: DraftPurpose | null = safety
    ? "safety"
    : opts.purpose === "thank_you"
      ? thankWithReview
        ? "thank_you_review"
        : "thank_you"
      : (opts.purpose ??
        (!followup &&
        isQuoteAcceptance(thread) &&
        // Check 38 P1: a yes to a change order on a job already won is answered as an
        // ordinary reply, never with a deposit note.
        !changeOrder &&
        !(await wonBeforeNewestEmail(thread)) &&
        paymentSaid(thread.extracted) === null &&
        !(await depositAlreadyOn(threadId))
          ? "deposit"
          : null));

  const [pending] = await db()
    .select({ id: drafts.id })
    .from(drafts)
    .where(and(eq(drafts.threadId, threadId), eq(drafts.status, "pending")));
  if (pending) return { status: "skipped", reason: "already_pending" };

  // A nudge or closing question follows the owner's own last message; a review request
  // may follow either; everything else answers the customer.
  const afterOwner = followup || purpose === "closing_question";
  // An unsent Gmail draft is not part of the conversation: never "the owner wrote", never
  // text for the model or the checks, never what a nudge is threaded to (notDraftMessage).
  // For a nudge or closing question, neither is a side conversation (a forward to the crew
  // and the crew's reply, `sideEmailSql`): the same "who wrote last" as the follow-up scan,
  // so a thread it picks isn't skipped here, and the note is threaded to — and only shows
  // the model — the conversation with the customer.
  const conversation = afterOwner
    ? and(eq(messages.threadId, threadId), notDraftMessage(), sql`not ${sideEmailSql("messages")}`)
    : and(eq(messages.threadId, threadId), notDraftMessage());
  const recent = (
    await db()
      .select()
      .from(messages)
      .where(conversation)
      .orderBy(desc(messages.sentAt))
      .limit(CONVERSATION_MESSAGES)
  ).reverse();
  const last = recent.at(-1);
  if (!last) return { status: "skipped", reason: "no_text" };
  if (afterOwner && last.direction !== "out")
    return { status: "skipped", reason: "customer_replied" };
  if (
    !afterOwner &&
    purpose !== "review_request" &&
    !isThankYou(purpose) &&
    last.direction !== "in"
  )
    return { status: "skipped", reason: "owner_replied_last" };
  // Who the reply goes to: the customer — whoever last wrote in.
  const customer =
    last.direction !== "in"
      ? (
          await db()
            .select()
            .from(messages)
            .where(and(conversation, eq(messages.direction, "in")))
            .orderBy(desc(messages.sentAt))
            .limit(1)
        )[0]
      : last;
  if (!customer) return { status: "skipped", reason: "no_text" };
  // Where the reply goes (review B1): a website form's Reply-To, read at sync. A row stored
  // before sync read it is read now, before the model is asked anything — never guessed: if
  // Gmail can't say, there is no draft (a reply to the form robot reads "Reply sent." and
  // reaches nobody).
  if (customer.replyToHeader === null) {
    let read: ReplyToHeader;
    try {
      const reader = replyReader(mailbox, opts);
      if (!reader) throw new Error("No Gmail reader.");
      read = await readReplyTo(reader, customer, await workspaceMailboxEmails(workspace.id));
    } catch (err) {
      if (err instanceof MailboxAuthError) {
        await markReconnectNeeded(mailbox);
        return { status: "reconnect_needed" };
      }
      // A job pauses and tries again (politely()); the owner's tap gets a plain notice.
      if (opts.trigger !== "owner") throw err;
      console.error("reply_to_read_failed", {
        threadId,
        error: err instanceof Error ? err.name : "unknown",
      });
      return {
        status: "skipped",
        reason: err instanceof MailboxRateLimitError ? "gmail_busy" : "reply_to_unread",
      };
    }
    customer.replyToHeader = read;
    for (const m of recent) if (m.id === customer.id) m.replyToHeader = read;
  }
  const to = customerReplyAddress(customer);
  if (!to) return { status: "skipped", reason: "no_text" };
  // An email-to-text gateway (a form whose Reply-To is 5085551234@vtext.com, a Google Voice
  // text): a reply would text the customer, and Squared Away never texts customers. Not even
  // on the owner's tap — the card offers "Text from my phone" instead (leads package).
  if (isEmailToTextAddress(to)) return { status: "skipped", reason: "text_address" };
  // A thread sorted before lead channels existed: the address itself says it's a lead site.
  if (channelOf(to)?.kind === "site") return { status: "skipped", reason: "lead_site" };
  // A phone-number-shaped address at a gateway we don't know: jobs skip it; the owner's tap
  // drafts it with a flag first (which also keeps it out of batch and autopilot). An address
  // the owner has written to before is theirs to use.
  const maybeText = looksLikePhoneAddress(to) && !(await knownCustomer(mailbox.id, to, now));
  if (maybeText && opts.trigger !== "owner")
    return { status: "skipped", reason: "maybe_text_address" };
  // A robot never gets a reply (round 2 A9): a no-reply address, a form robot with no usable
  // Reply-To, a portal's dispatch address. Not even on the owner's tap — nobody reads it, and
  // "Reply sent." would be untrue. They answer those on the platform or by phone.
  if (isNoReplyAddress(to)) return { status: "skipped", reason: "no_reply_address" };
  // Check 22 P4: a safety note never goes to mail sorted as junk (a utility's bill, a
  // newsletter) unless the owner has written to that address before.
  if (safety && thread.category === "noise" && !(await knownCustomer(mailbox.id, to, now)))
    return { status: "skipped", reason: "noise" };
  const withText = recent
    .map((m) => ({
      m,
      text: prepareBody(m.bodyText ?? m.snippet ?? "").slice(0, PER_MESSAGE_CHARS),
    }))
    .filter((x) => x.text.length > 0);
  if (!withText.some((x) => x.m.id === last.id)) return { status: "skipped", reason: "no_text" };
  // Every customer email the drafter will read is checked in code (round 2 B3), not only the
  // newest one the sorter saw: an older "ignore the above…" still in view means no job draft.
  if (opts.trigger !== "owner") {
    const inbound = withText.filter((x) => x.m.direction === "in").map((x) => x.text);
    // Check 22 P2: emails the owner already said were normal ("This is a normal email") aren't
    // held against the thread; anything newer still is.
    const clearedAt = (thread.extracted as { injection_cleared_at?: unknown } | null)
      ?.injection_cleared_at;
    const clearedMs = typeof clearedAt === "string" ? Date.parse(clearedAt) : NaN;
    const unchecked = withText
      .filter(
        (x) =>
          x.m.direction === "in" &&
          !(Number.isFinite(clearedMs) && x.m.sentAt.getTime() <= clearedMs),
      )
      .map((x) => x.text);
    if (unchecked.some((t) => injectionCheck(t).flagged))
      return { status: "skipped", reason: "untrusted" };
    if (inbound.some((t) => looksLikePaymentChange(t)))
      return { status: "skipped", reason: "payment_change" };
  }

  const ctx = await workspaceContext(workspace.id, workspace, now);
  // Nothing to ask with: never call the model for a review request without the link.
  if (purpose === "review_request" && !ctx.reviewUrl)
    return { status: "skipped", reason: "no_review_link" };
  // The link went from the profile since the check: a plain thank-you, never a broken ask.
  if (purpose === "thank_you_review" && !ctx.reviewUrl) purpose = "thank_you";
  // Replies package (draft.v7): a first reply to someone the owner never wrote to — on any
  // thread, from any mailbox, a side email to the crew aside — opens warmly and takes a shape
  // from what they said. An ordinary reply about a job only; the gas safety note stays as is.
  const contact = {
    followup,
    purpose,
    category: thread.category,
    gasSmell: safetyKind !== null,
    handledOffline: thread.handledOfflineAt != null,
  };
  // The database is only asked when everything else already says "first contact". The
  // customer is their reply address, as everywhere else (B1): a website form's robot From is
  // shared by every lead, so an old reply to the robot never makes a new person "known".
  const firstContact =
    isFirstContact({ ...contact, ownerWroteBefore: false }) &&
    !(await ownerWroteBefore({
      workspaceId: workspace.id,
      threadId,
      addresses: [to],
      before: now,
    }));
  const daysQuiet = Math.max(1, Math.round((now.getTime() - last.sentAt.getTime()) / 86_400_000));
  // Check 43 P9: a reply about a dispute or something legal can become the record. Fixed words
  // (not the model's) keep it short and factual, and a fixed flag means it never reads Ready.
  const dispute = !safety && disputeThread(thread);
  const wsBlock = workspaceBlock(ctx);
  const baseTask = followup
    ? followupTask({ nudgeNumber, daysQuiet })
    : purpose === "deposit"
      ? depositTask({ paymentTerms: ctx.paymentTerms })
      : purpose === "review_request"
        ? reviewRequestTask({ reviewUrl: ctx.reviewUrl! })
        : purpose === "closing_question"
          ? closingQuestionTask({ daysQuiet })
          : isThankYou(purpose)
            ? thankYouTask({ reviewUrl: purpose === "thank_you_review" ? ctx.reviewUrl : null })
            : firstContact
              ? FIRST_CONTACT_TASK
              : undefined;
  const convo = conversationBlock({
    now,
    timeZone: ctx.timeZone,
    subject: thread.subject,
    category: thread.category,
    summary: thread.summary,
    extracted: thread.extracted,
    ownerNote: opts.ownerNote,
    task: dispute ? `${baseTask ?? DEFAULT_REPLY_TASK}\n\n${DISPUTE_TASK}` : baseTask,
    messages: withText.map(({ m, text }) => ({
      from:
        m.direction === "out"
          ? mailbox.email
          : (customerReplyName(m) ?? customerReplyAddress(m) ?? "customer"),
      direction: m.direction,
      sentAt: m.sentAt,
      body: text,
    })),
  });

  // What the draft may draw facts from, and what it must never say.
  const ownerFacts = [
    ctx.pricingNotes,
    ctx.hours,
    ctx.leadTime,
    ctx.policies,
    ctx.paymentTerms,
    ctx.services,
    ctx.signature,
    // Check 38 P6: the saved license numbers are the owner's own words.
    licenseFacts(ctx.licenses),
    ...ctx.seasonalNotes.map((n) => n.text),
    // Check 23 P3: a seasonal note's last day, as a draft would write it ("November 27").
    ...ctx.seasonalNotes.map((n) => spellDate(n.endsOn)),
  ];
  const lastInbound = [...withText].reverse().find((x) => x.m.direction === "in");
  const checkContext = {
    sourceText: [withText.map((x) => x.text).join("\n"), ...ownerFacts, opts.ownerNote]
      .filter(Boolean)
      .join("\n"),
    ...whenContext(
      ctx,
      withText,
      [opts.ownerNote],
      now,
      asksWhenAvailable(lastInbound?.text ?? ""),
    ),
    // Amounts only the customer named aren't the owner's price (round 2 A4).
    ownerSourceText: [
      ...withText.filter((x) => x.m.direction === "out").map((x) => x.text),
      ...ownerFacts,
      opts.ownerNote,
    ]
      .filter(Boolean)
      .join("\n"),
    ownerInstruction: opts.ownerNote ?? null,
    doNotPromise: ctx.doNotPromise,
    phrasesAvoided: ctx.voice?.phrasesAvoided ?? [],
    neverSay: ctx.neverSay,
    licenses: ctx.licenses,
    state: ctx.state,
    // Check 23 P14: hold the price list's "from" and the job each price is for.
    priceList: ctx.pricingNotes,
    // Check 23 P13: a first reply's "Thanks for reaching out" isn't filler.
    firstContact,
    // Check 23 P6: the names on the conversation's From lines may be used.
    knownNames: withText
      .flatMap(({ m }) => [m.fromName, customerReplyName(m)])
      .filter((n): n is string => !!n),
    // Check 23 P5: every reply carries the owner's terms for the light payment-terms check
    // (deposit and review notes replace these with their own, stricter check below).
    termsSource: ownerTerms(ctx),
    ownerWrote: withText
      .filter((x) => x.m.direction === "out")
      .map((x) => x.text)
      .join("\n"),
    // Deposit and review notes: no percentage, way to pay or incentive the owner never set (A4).
    ...termsCheck(purpose, ctx, {
      wrote: withText.filter((x) => x.m.direction === "out").map((x) => x.text),
    }),
  };
  const basePromptVersion =
    safety && safetyKind
      ? SAFETY_NOTES[safetyKind].version
      : followup
        ? FOLLOWUP_PROMPT_VERSION
        : purpose
          ? `${DRAFT_PROMPT_VERSION}+${PURPOSE_PROMPT_VERSION}`
          : DRAFT_PROMPT_VERSION;
  // Check 43 P9: the dispute caution is recorded as a suffix on whichever prompt drafted it.
  const promptVersion = dispute
    ? `${basePromptVersion}+${DISPUTE_CAUTION_PROMPT_VERSION}`
    : basePromptVersion;

  let result: (ModelDraft & { opening?: Opening }) | null = null;
  if (safety && safetyKind) result = SAFETY_NOTES[safetyKind].note(ctx);
  else
    try {
      const request = {
        workspaceId: workspace.id,
        role: "draft" as const,
        promptVersion,
        maxTokens: 4096,
        effort: "medium" as const,
        mode: opts.aiMode ?? ("job" as const),
        system: [
          { text: followup ? FOLLOWUP_INSTRUCTIONS : DRAFT_INSTRUCTIONS, cache: false },
          { text: wsBlock, cache: true },
        ],
        user: convo,
        // Replies (and purpose notes) carry draft.v7's `opening`; nudges keep their own output.
        schema: followup ? draftSchema : replyDraftSchema,
        now,
      };
      result = (await callStructured(request)) ?? (await callStructured(request));
      if (result?.body.trim()) {
        // Something the owner explicitly banned slipped in: one fresh attempt, then flag (plan #23).
        const first = checkDraft(result.body.trim(), checkContext);
        if (first.hits.some((h) => REGENERATE_ON.includes(h))) {
          const retry = await callStructured({
            ...request,
            user: `${convo}\n\nYour last attempt broke the owner's rules: ${first.flags.join(" ")} Write it again without that.`,
          });
          if (retry?.body.trim()) result = retry;
        }
      }
    } catch (err) {
      if (err instanceof AiCapReachedError) return { status: "skipped", reason: "capped" };
      throw err;
    }
  if (!result || !result.body.trim()) return { status: "skipped", reason: "model_failed" };

  // What the owner must sort before a purpose note can go (A6).
  const { body, flags: purposeFlags } = purposeGuards(purpose, result.body.trim(), ctx);
  const scored = scoreDraft(result, checkDraft(body, checkContext), [
    ...(maybeText ? [MAYBE_TEXT_FLAG] : []),
    ...(safety && safetyKind ? [SAFETY_NOTES[safetyKind].flag, ...purposeFlags] : purposeFlags),
  ]);
  // Check 43 P9: the fixed caution goes first (so the cut to six never drops it), and the
  // card never says Ready on one of these. Check 38 P1: a change order's reminder next.
  const fixedFlags = [
    ...(dispute ? [DISPUTE_FLAG] : []),
    ...(changeOrder && !followup && !safety ? [CHANGE_ORDER_FLAG] : []),
  ];
  const flags = [...new Set([...fixedFlags, ...scored.flags])].slice(0, 6);
  const confidence = dispute
    ? Math.min(scored.confidence, Math.round(DISPUTE_CONFIDENCE_CAP * 100))
    : scored.confidence;

  const subject = replySubject(last.subject ?? thread.subject);
  const writer = (opts.writerFor ?? defaultWriter)(mailbox);

  let created: { draftId: string; messageId: string };
  try {
    created = await writer.createDraft({
      threadId: thread.gmailThreadId,
      raw: toGmailRaw(
        buildReplyMime({
          from: mailbox.email,
          to,
          subject,
          inReplyTo: last.rfc822MessageId,
          references: last.references,
          body,
        }),
      ),
    });
  } catch (err) {
    if (err instanceof MailboxAuthError) {
      await markReconnectNeeded(mailbox);
      return { status: "reconnect_needed" };
    }
    throw err;
  }

  const insertDraft = (q: Pick<ReturnType<typeof db>, "insert">) =>
    q
      .insert(drafts)
      .values({
        threadId,
        mailboxId: mailbox.id,
        replyToMessageId: last.id,
        // Purpose notes are replies, so they never count as a nudge (followup_count).
        kind: followup ? "followup" : "reply",
        purpose,
        gmailDraftId: created.draftId,
        gmailMessageId: created.messageId,
        toAddress: to,
        subject,
        body,
        originalBody: body,
        reason:
          result.reason.trim().slice(0, 200) || (followup ? "Follow-up nudge." : "Reply drafted."),
        flags,
        confidence,
        usedFacts: [...new Set(result.used_facts ?? [])],
        // A key, never text: the shape of a first reply (null on every other draft).
        opening: storedOpening(firstContact, result.opening),
        promptVersion,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: drafts.id });

  let row2: { id: string } | undefined;
  let reviewTaken = false;
  if (asksForReview(purpose)) {
    // One review request per address a year, even with two taps on two threads at once
    // (A16): the check and the insert run under a lock on this workspace + address.
    await db().transaction(async (tx) => {
      await lockReviewAddress(tx, workspace.id, to);
      if ((await recentReviewAddresses(workspace.id, now, tx)).has(to.toLowerCase())) {
        reviewTaken = true;
        return;
      }
      [row2] = await insertDraft(tx);
    });
  } else {
    [row2] = await insertDraft(db());
  }
  if (!row2) {
    // Lost a race with another run; don't leave an orphan in Gmail.
    await writer.deleteDraft(created.draftId);
    if (reviewTaken) return { status: "skipped", reason: "review_recent" };
    // The insert skips on any unique index: tell "asked once already" (the closing question's
    // own index, A7) apart from "a draft is already waiting".
    if (purpose === "closing_question") {
      const [asked] = await db()
        .select({ id: drafts.id })
        .from(drafts)
        .where(and(eq(drafts.threadId, threadId), eq(drafts.purpose, "closing_question")))
        .limit(1);
      if (asked) return { status: "skipped", reason: "already_asked" };
    }
    // The thank-you's own index (once per thread, 2026-10-16).
    if (isThankYou(purpose)) {
      const [thanked] = await db()
        .select({ id: drafts.id })
        .from(drafts)
        .where(
          and(
            eq(drafts.threadId, threadId),
            inArray(drafts.purpose, [...THANK_YOU_PURPOSES]),
            ne(drafts.status, "expired"),
          ),
        )
        .limit(1);
      if (thanked) return { status: "skipped", reason: "already_asked" };
    }
    return { status: "skipped", reason: "already_pending" };
  }
  if (followup) {
    // The owner may have decided the quote (or marked the invoice paid) while the model was
    // writing. Checked after the insert: setQuoteOutcome / setInvoicePaid write their mark
    // before they look for a waiting nudge, so either they find this row, or this re-read
    // sees the mark. Whoever removes the row removes the Gmail draft. Our own paid guess
    // lands here too: a nudge being written as it happens is simply dropped.
    const [fresh] = await db()
      .select({
        quoteOutcome: threads.quoteOutcome,
        category: threads.category,
        invoicePaidAt: threads.invoicePaidAt,
      })
      .from(threads)
      .where(eq(threads.id, threadId));
    if (fresh && (quoteStopsNudges(fresh) || fresh.invoicePaidAt != null)) {
      const gone = await db()
        .delete(drafts)
        .where(and(eq(drafts.id, row2.id), eq(drafts.status, "pending")))
        .returning({ id: drafts.id });
      if (gone.length) await writer.deleteDraft(created.draftId);
      return { status: "skipped", reason: "followup_not_allowed" };
    }
  }

  await bumpUsageCounter(workspace.id, "draftsCreated", now);
  await db()
    .insert(activityLog)
    .values({
      workspaceId: workspace.id,
      actor: "squared_away",
      action:
        purpose === "closing_question"
          ? "closing_question"
          : followup
            ? "followup_drafted"
            : "draft_created",
      threadId,
      detail: {
        draftId: row2.id,
        trigger: opts.trigger,
        confidence,
        flagCount: flags.length,
        ...(followup ? { nudgeNumber } : {}),
        ...(purpose ? { purpose } : {}),
        ...(firstContact ? { firstContact: true } : {}),
      },
    });
  return { status: "created", draftId: row2.id };
}

async function loadOwnedDraft(workspaceId: string, draftId: string) {
  const [row] = await db()
    .select({ draft: drafts, mailbox: mailboxes, thread: threads, workspace: workspaces })
    .from(drafts)
    .innerJoin(mailboxes, eq(mailboxes.id, drafts.mailboxId))
    .innerJoin(threads, eq(threads.id, drafts.threadId))
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(and(eq(drafts.id, draftId), eq(mailboxes.workspaceId, workspaceId)));
  return row;
}

export function mimeFor(
  d: Draft,
  mailbox: Mailbox,
  body: string,
  replyTo: { rfc822MessageId: string | null; references: string | null } | undefined,
) {
  return toGmailRaw(
    buildReplyMime({
      from: mailbox.email,
      to: d.toAddress,
      subject: d.subject,
      inReplyTo: replyTo?.rfc822MessageId,
      references: replyTo?.references,
      body,
    }),
  );
}

export async function replyToHeaders(d: Pick<Draft, "replyToMessageId">) {
  if (!d.replyToMessageId) return undefined;
  const [m] = await db()
    .select({ rfc822MessageId: messages.rfc822MessageId, references: messages.references })
    .from(messages)
    .where(eq(messages.id, d.replyToMessageId));
  return m;
}

export type SendOutcome =
  | { status: "sent"; edited: boolean; toName: string | null }
  | { status: "blocked"; reason: string }
  | { status: "changed_in_gmail" }
  | { status: "deleted_in_gmail" }
  | { status: "gaps_unfilled" }
  | { status: "no_reply_address" }
  /** Leads package: the draft goes to an email-to-text gateway. Never sent; closed. */
  | { status: "text_address" }
  | { status: "already_sending" }
  | { status: "not_found" }
  | { status: "reconnect_needed" }
  /** The plan covers fewer Gmail addresses and this one is paused (MAILBOX_PAUSED_LINE). */
  | { status: "mailbox_paused" }
  /**
   * Check 42 P1: someone already answered the customer from Gmail (the office, or the owner
   * at a computer) after this draft was written. Nothing is sent: a second answer would go out.
   */
  | { status: "answered_elsewhere"; at: Date }
  /**
   * Check 43 P7: the draft says "tomorrow" (or "in a few minutes") but was written on an earlier
   * day (or hours ago). Nothing is sent until the owner confirms (`confirmedTiming`).
   */
  | ({ status: "timing_check" } & StaleTiming);

/** Check 43 P9: a thread about a dispute or something legal (the mark, or the reason shown). */
function disputeThread(t: { extracted: unknown; needsOwnerReason: string | null }) {
  return (
    (t.extracted as { disputed?: boolean } | null)?.disputed === true ||
    (t.needsOwnerReason != null && DISPUTE_REASONS.includes(t.needsOwnerReason))
  );
}

/** Check 38 P1: the fixed flag on a reply to a change-order approval (no legal claim). */
export const CHANGE_ORDER_FLAG =
  "Change order approved. Put it in writing with the price and any new finish date.";

/** Check 38 P1: the newest email said yes on a job that was already won (classification). */
function changeOrderApproved(t: { extracted: unknown }) {
  return (
    (t.extracted as { change_order_approved?: boolean } | null)?.change_order_approved === true
  );
}

/**
 * Check 38 P1: the thread's quote was marked won (by anyone) before its newest customer email,
 * so a yes in that email is about something else — a change order — not the quote.
 */
async function wonBeforeNewestEmail(t: {
  id: string;
  quoteOutcome: string | null;
  quoteOutcomeAt: Date | null;
}) {
  if (t.quoteOutcome !== "won" || !t.quoteOutcomeAt) return false;
  const [newest] = await db()
    .select({ at: sql<string | Date | null>`max(${messages.sentAt})` })
    .from(messages)
    .where(and(eq(messages.threadId, t.id), eq(messages.direction, "in"), notDraftMessage()));
  const at = asDate(newest?.at);
  return at != null && at.getTime() > t.quoteOutcomeAt.getTime();
}

/** What the drafter is asked when no other task applies (draft.vN's own default words). */
const DEFAULT_REPLY_TASK = "Write the owner's reply to the last CUSTOMER message.";

/** Check 43 P7: the draft's time words that may be out of date now, in the owner's zone. */
async function timingFor(workspaceId: string, body: string, createdAt: Date, now: Date) {
  return staleTiming(body, createdAt, now, await workspaceTimeZone(workspaceId));
}

/** Check 42 P1: the note on a reply set aside because the customer was answered from Gmail. */
export const ANSWERED_ELSEWHERE_NOTE =
  "Someone answered this from Gmail, so this reply was set aside.";

/**
 * Check 42 P1: when the customer was first answered from Gmail after `since`, or null. An email
 * from the shop's address on the thread counts unless it is an unsent Gmail draft, a practice
 * copy (it went only to the mailbox's own address) or a side conversation (a forward to the
 * crew, `sideEmailSql`): those answer nobody.
 */
export async function answeredSince(
  threadId: string,
  since: Date,
  mailboxEmail: string,
): Promise<Date | null> {
  const own = mailboxEmail.trim().toLowerCase();
  const [first] = await db()
    .select({ at: messages.sentAt })
    .from(messages)
    .where(
      and(
        eq(messages.threadId, threadId),
        eq(messages.direction, "out"),
        gt(messages.sentAt, since),
        notDraftMessage(),
        sql`not (jsonb_array_length(${messages.toAddresses} || ${messages.ccAddresses}) > 0 and not exists (select 1 from jsonb_array_elements_text(${messages.toAddresses} || ${messages.ccAddresses}) as ae_r(a) where lower(trim(ae_r.a)) <> ${own}))`,
        sql`not ${sideEmailSql("messages")}`,
      ),
    )
    .orderBy(asc(messages.sentAt))
    .limit(1);
  return first?.at ?? null;
}

/**
 * Send a pending draft — the only way anything leaves the owner's inbox.
 * Order matters: lifecycle gate first (no Google call at all when blocked),
 * then reconcile against Gmail so we never send text the owner hasn't seen.
 * `editedBody` is the text in front of the owner when they tapped Send.
 */
export async function sendDraft(
  workspaceId: string,
  draftId: string,
  opts: DraftDeps & {
    editedBody?: string;
    /** Who pressed send: the owner, or autopilot after its checks and grace window. */
    by?: "owner" | "autopilot";
    /** The undo window has ended and this caller holds the claim (deliverQueuedSend). */
    queued?: boolean;
    /** Check 43 P7: the owner saw the timing note and tapped Send reply anyway. */
    confirmedTiming?: boolean;
  } = {},
): Promise<SendOutcome> {
  const now = opts.now?.() ?? new Date();
  const row = await loadOwnedDraft(workspaceId, draftId);
  if (!row || row.draft.status !== "pending" || !row.draft.gmailDraftId)
    return { status: "not_found" };
  const { draft, mailbox, thread, workspace } = row;
  // A draft in its undo window only leaves through the job that claimed it (plan #7).
  if (opts.queued ? !draft.sendAfter : draft.sendAfter) {
    return opts.queued ? { status: "not_found" } : { status: "already_sending" };
  }
  // Check 9 P2: autopilot sends only a draft it still holds: counting down (not held, edited
  // or switched off since) and claimed by this run. Anything that cleared the countdown wins.
  if (opts.by === "autopilot" && (!draft.autoSendAt || !draft.autoSendClaimedAt))
    return { status: "not_found" };
  if (!canSend(workspace, now)) throw new SendingBlockedError(effectiveStatus(workspace, now));
  // Paused on the plan (2026-10-16): refused before any Gmail call, whoever pressed send.
  if (mailbox.planPausedAt) return { status: "mailbox_paused" };
  if (mailbox.status !== "active") return { status: "reconnect_needed" };
  // A reply with a {{gap}} still in it never leaves (plan #2) — checked before any Gmail call.
  if (hasUnfilledGap(opts.editedBody ?? draft.body ?? "")) return { status: "gaps_unfilled" };
  // Nor one to a robot (round 2 A9), whoever wrote it: nobody would read it.
  if (isNoReplyAddress(draft.toAddress)) return { status: "no_reply_address" };
  // Nor one that would text the customer (leads package): a draft made before this rule, an
  // offline okay, batch or autopilot. Closed here with no Gmail call; the Gmail draft stays in
  // the owner's Gmail.
  if (isEmailToTextAddress(draft.toAddress)) {
    await closeDraft(draft, workspaceId, "discarded", TEXT_ADDRESS_NOTE, now);
    return { status: "text_address" };
  }
  // Check 42 P1: answered from Gmail since this was written (also covers a send in its undo
  // window): never a second answer. Checked before any Gmail call.
  const answeredAt = await answeredSince(thread.id, draft.createdAt, mailbox.email);
  if (answeredAt) return { status: "answered_elsewhere", at: answeredAt };
  // Check 43 P7: an old "tomorrow" never leaves without the owner seeing the note. Autopilot
  // can't confirm, so it never sends one.
  if (!opts.confirmedTiming) {
    const t = await timingFor(
      workspaceId,
      opts.editedBody ?? draft.body ?? "",
      draft.createdAt,
      now,
    );
    if (t) return { status: "timing_check", ...t };
  }

  const writer = (opts.writerFor ?? defaultWriter)(mailbox);
  try {
    const remote = await writer.getDraft(draft.gmailDraftId!);
    if (!remote) {
      await closeDraft(
        draft,
        workspaceId,
        "discarded",
        "You deleted or sent this draft in Gmail.",
        now,
      );
      return { status: "deleted_in_gmail" };
    }
    if (!sameText(remote.bodyText, draft.body)) {
      // Changed in Gmail since the owner last saw it. Show them the new text; don't send blind.
      await db()
        .update(drafts)
        .set({ body: remote.bodyText, autoSendAt: null })
        .where(eq(drafts.id, draft.id));
      return { status: "changed_in_gmail" };
    }

    let body = draft.body ?? "";
    if (opts.editedBody !== undefined && !sameText(opts.editedBody, body)) {
      body = opts.editedBody.trim();
      await writer.updateDraft(draft.gmailDraftId!, {
        threadId: thread.gmailThreadId,
        raw: mimeFor(draft, mailbox, body, await replyToHeaders(draft)),
      });
    }

    const sent = await writer.sendDraft(draft.gmailDraftId!);
    const edited = !sameText(body, draft.originalBody);
    await db()
      .update(drafts)
      .set({
        status: edited ? "edited_and_sent" : "sent",
        sentVia: opts.by === "autopilot" ? "autopilot" : "app",
        body,
        decidedAt: now,
        sentGmailMessageId: sent.messageId,
        sendAfter: null,
        sendClaimedAt: null,
      })
      .where(eq(drafts.id, draft.id));
    await db()
      .update(threads)
      .set({
        needsOwner: false,
        needsOwnerManual: false,
        needsOwnerReason: null,
        awaitingReplySince: now,
        ...(draft.kind === "followup" ? { followupCount: sql`${threads.followupCount} + 1` } : {}),
      })
      .where(eq(threads.id, thread.id));
    await bumpUsageCounter(workspaceId, "emailsSent", now);
    await db()
      .insert(activityLog)
      .values({
        workspaceId,
        actor: opts.by === "autopilot" ? "squared_away" : "owner",
        action: "reply_sent",
        threadId: thread.id,
        detail: {
          draftId: draft.id,
          editedByOwner: edited,
          kind: draft.kind,
          gmailMessageId: sent.messageId,
          // Ideas H8: whether the draft as written had {{gaps}} to fill (yes/no only): filling
          // one isn't counted as changing the draft.
          hadGaps: findGaps(draft.originalBody ?? draft.body ?? "").length > 0,
          ...(opts.queued ? { undoWindowSec: UNDO_WINDOW_SECONDS } : {}),
          ...(opts.by === "autopilot" ? { autopilot: true } : {}),
        },
      });
    // Last, after the record of the send: storing the sent email is a nice-to-have (Gmail
    // reads can retry for a while), the activity row is what Activity and /record rely on.
    await recordSent(mailbox, writer, sent, now);
    return { status: "sent", edited, toName: (await customerOf(thread.id))?.name ?? null };
  } catch (err) {
    if (err instanceof MailboxAuthError) {
      await markReconnectNeeded(mailbox);
      return { status: "reconnect_needed" };
    }
    throw err;
  }
}

/**
 * Store the email a send just made as the owner's mail, now. How Gmail's history reports a sent
 * draft (a new message, or the draft's own id relabelled SENT) then doesn't matter for app
 * sends. The Gmail client reads as well as writes; a writer that can't read (tests) skips this.
 * Best effort: it's already sent, and the next sync picks the message up anyway.
 */
async function recordSent(
  mailbox: Mailbox,
  writer: MailboxWriter,
  sent: { messageId: string; threadId: string },
  now: Date,
) {
  const reader = writer as Partial<Pick<MailboxReader, "getMessage">>;
  if (typeof reader.getMessage !== "function") return;
  try {
    await recordSentMessage(
      mailbox,
      { getMessage: reader.getMessage.bind(writer) },
      { id: sent.messageId, threadId: sent.threadId },
      now,
    );
  } catch (err) {
    console.error("sent_message_record_failed", {
      mailboxId: mailbox.id,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}

/**
 * A tap that lost a race: "already sending" only if another tap really did start the undo
 * window; anything else (closed, expired, discarded) is "not found" — never shown as sent.
 */
async function whyNotQueued(draftId: string): Promise<{ status: "already_sending" | "not_found" }> {
  const [row] = await db()
    .select({ status: drafts.status, sendAfter: drafts.sendAfter })
    .from(drafts)
    .where(eq(drafts.id, draftId));
  const sending =
    (row?.status === "pending" && row.sendAfter != null) ||
    row?.status === "sent" ||
    row?.status === "edited_and_sent";
  return sending ? { status: "already_sending" } : { status: "not_found" };
}

/**
 * Check 9 P3: Gmail failed while a tap was being handled. Nothing was sent (and nothing
 * changed); the owner is told so and can try again. Rate limit → gmail_busy, anything else
 * (5xx, network) → gmail_failed. Only the error's name and the draft id are logged.
 */
export type GmailHiccup = "gmail_busy" | "gmail_failed";
function gmailHiccup(err: unknown, where: string, draftId: string): GmailHiccup {
  const kind = err instanceof MailboxRateLimitError ? "gmail_busy" : "gmail_failed";
  console.error(`${where}_gmail_failed`, {
    draftId,
    kind,
    error: err instanceof Error ? err.name : "unknown",
  });
  return kind;
}

export type QueueSendOutcome =
  | { status: "queued"; sendAfter: Date }
  | { status: GmailHiccup }
  | { status: "changed_since_seen" }
  | { status: "intent_expired" }
  /** Who it goes to changed since the card was shown (a Reply-To re-point): look again. */
  | { status: "to_changed" }
  | Exclude<SendOutcome, { status: "sent" }>;

/** Two addresses are the same mailbox (case and spaces aside). */
const sameAddress = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/** Plan #10: an okay given with no signal counts for this long, no longer. */
export const OFFLINE_INTENT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** The fingerprint of a draft's text, as the phone saw it (sha-256, hex). */
export const bodyHash = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");

/**
 * Plan #7: the owner tapped Send reply. Every check a send makes runs now (so
 * a blocked account still gets its 403 and nothing unchecked waits), the text
 * they approved is written to the Gmail draft, and it goes after the undo
 * window — via deliverQueuedSend, which checks everything again then.
 */
export async function queueSend(
  workspaceId: string,
  draftId: string,
  opts: DraftDeps & {
    editedBody?: string;
    device?: "phone" | "computer";
    /**
     * Plan #10, an okay given offline: the text the owner saw (its hash) and
     * when they tapped. If the draft changed since, or it was over 12 hours
     * ago, nothing is sent and they're told.
     */
    offline?: { seenHash: string; okayedAt: Date };
    /**
     * The address the card showed when Send reply was tapped (H7 "To:"). If the draft now goes
     * somewhere else, nothing is queued and the owner is asked to look again: the same rule
     * as a draft changed in Gmail — never send what they haven't seen.
     */
    seenTo?: string;
    /**
     * Check 9 P1: the fingerprint (bodyHash) of the text the card showed when Send reply was
     * tapped. If the draft's text changed since (taken from Gmail by a sync, changed on another
     * device), nothing is queued: the owner reads the new text first.
     */
    seenHash?: string;
    /** Check 43 P7: the owner saw the timing note and tapped Send reply anyway. */
    confirmedTiming?: boolean;
  } = {},
): Promise<QueueSendOutcome> {
  const now = opts.now?.() ?? new Date();
  const row = await loadOwnedDraft(workspaceId, draftId);
  if (!row || row.draft.status !== "pending" || !row.draft.gmailDraftId)
    return { status: "not_found" };
  const { draft, mailbox, thread, workspace } = row;
  // Check 9 P2: autopilot is sending this one right now; a tap can't start a second send.
  if (draft.sendAfter || autopilotSending(draft, now)) return { status: "already_sending" };
  if (!canSend(workspace, now)) throw new SendingBlockedError(effectiveStatus(workspace, now));
  if (opts.offline) {
    const age = now.getTime() - opts.offline.okayedAt.getTime();
    if (!(age >= -5 * 60_000 && age <= OFFLINE_INTENT_MAX_AGE_MS))
      return { status: "intent_expired" };
    if (opts.offline.seenHash !== bodyHash(draft.body ?? ""))
      return { status: "changed_since_seen" };
  }
  if (opts.seenTo !== undefined && !sameAddress(opts.seenTo, draft.toAddress))
    return { status: "to_changed" };
  if (opts.seenHash !== undefined && opts.seenHash !== bodyHash(draft.body ?? ""))
    return { status: "changed_since_seen" };
  if (mailbox.planPausedAt) return { status: "mailbox_paused" };
  if (mailbox.status !== "active") return { status: "reconnect_needed" };
  if (hasUnfilledGap(opts.editedBody ?? draft.body ?? "")) return { status: "gaps_unfilled" };
  if (isNoReplyAddress(draft.toAddress)) return { status: "no_reply_address" };
  // Refused at the tap, before anything is queued (leads package). Nothing is closed here:
  // the owner sees why and the card stays until reconcile clears it.
  if (isEmailToTextAddress(draft.toAddress)) return { status: "text_address" };
  // Check 42 P1: someone answered from Gmail since this was written. Nothing is queued; the
  // next sync sets the draft aside (reconcileDrafts).
  const answeredAt = await answeredSince(thread.id, draft.createdAt, mailbox.email);
  if (answeredAt) return { status: "answered_elsewhere", at: answeredAt };
  if (!opts.confirmedTiming) {
    const t = await timingFor(
      workspaceId,
      opts.editedBody ?? draft.body ?? "",
      draft.createdAt,
      now,
    );
    if (t) return { status: "timing_check", ...t };
  }

  const writer = (opts.writerFor ?? defaultWriter)(mailbox);
  let body = draft.body ?? "";
  // Everything below runs while the row may change under us (another device closing the
  // nudge, say), so each write only lands on a draft that is still waiting for this tap.
  const stillWaiting = and(
    eq(drafts.id, draft.id),
    eq(drafts.status, "pending"),
    isNull(drafts.sendAfter),
  );
  try {
    const remote = await writer.getDraft(draft.gmailDraftId!);
    if (!remote) {
      const [closed] = await db()
        .update(drafts)
        .set({
          status: "discarded",
          closedNote: "You deleted or sent this draft in Gmail.",
          decidedAt: now,
        })
        .where(stillWaiting)
        .returning({ id: drafts.id });
      if (!closed) return await whyNotQueued(draft.id);
      await logClosed(draft, workspaceId, "discarded", "squared_away");
      return { status: "deleted_in_gmail" };
    }
    if (!sameText(remote.bodyText, draft.body)) {
      const [taken] = await db()
        .update(drafts)
        .set({ body: remote.bodyText, autoSendAt: null })
        .where(stillWaiting)
        .returning({ id: drafts.id });
      if (!taken) return await whyNotQueued(draft.id);
      return { status: "changed_in_gmail" };
    }
    if (opts.editedBody !== undefined && !sameText(opts.editedBody, body)) {
      body = opts.editedBody.trim();
      await writer.updateDraft(draft.gmailDraftId!, {
        threadId: thread.gmailThreadId,
        raw: mimeFor(draft, mailbox, body, await replyToHeaders(draft)),
      });
    }
  } catch (err) {
    if (err instanceof MailboxAuthError) {
      await markReconnectNeeded(mailbox);
      return { status: "reconnect_needed" };
    }
    // Nothing is queued yet: the tap failed, nothing went.
    return { status: gmailHiccup(err, "queue_send", draft.id) };
  }

  const sendAfter = new Date(now.getTime() + UNDO_WINDOW_SECONDS * 1000);
  const queued = await db()
    .update(drafts)
    .set({ body, sendAfter, sendClaimedAt: null, autoSendAt: null })
    // Still going where it went when this tap was checked (a re-point may have moved it), and
    // still the text that was checked (Check 9 P1: a sync may have taken Gmail's text since).
    .where(
      and(
        stillWaiting,
        eq(drafts.toAddress, draft.toAddress),
        sql`${drafts.body} is not distinct from ${draft.body}`,
        // Check 9 P2: an autopilot run that claimed it meanwhile sends it; this tap doesn't.
        or(
          isNull(drafts.autoSendClaimedAt),
          lt(drafts.autoSendClaimedAt, new Date(now.getTime() - AUTOPILOT_CLAIM_LEASE_MS)),
        ),
      ),
    )
    .returning({ id: drafts.id });
  // Two taps at once: only the first starts a window. Anything else that got there first
  // (the nudge closed on another device) means nothing is going out, and the owner is told so.
  if (!queued.length) {
    const [current] = await db()
      .select({
        to: drafts.toAddress,
        body: drafts.body,
        status: drafts.status,
        sendAfter: drafts.sendAfter,
        autoSendAt: drafts.autoSendAt,
        autoSendClaimedAt: drafts.autoSendClaimedAt,
      })
      .from(drafts)
      .where(eq(drafts.id, draft.id));
    if (current?.status === "pending" && current.sendAfter == null) {
      if (!sameAddress(current.to, draft.toAddress)) return { status: "to_changed" };
      if ((current.body ?? "") !== (draft.body ?? "")) return { status: "changed_since_seen" };
      if (autopilotSending(current, now)) return { status: "already_sending" };
    }
    return await whyNotQueued(draft.id);
  }
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: "owner",
      action: "send_approved",
      threadId: thread.id,
      // Content-free: what the proof-of-okay record (#41) shows.
      detail: {
        draftId: draft.id,
        device: opts.device ?? "unknown",
        undoWindowSec: UNDO_WINDOW_SECONDS,
        editedByOwner: !sameText(body, draft.originalBody),
        ...(opts.offline ? { offline: true } : {}),
      },
    });
  return { status: "queued", sendAfter };
}

/** Undo inside the window: back to the queue, unchanged. False once the send has started. */
export async function undoSend(workspaceId: string, draftId: string): Promise<boolean> {
  const undone = await db()
    .update(drafts)
    .set({ sendAfter: null })
    .where(
      and(
        eq(drafts.id, draftId),
        eq(drafts.status, "pending"),
        isNotNull(drafts.sendAfter),
        isNull(drafts.sendClaimedAt),
        inArray(
          drafts.mailboxId,
          db()
            .select({ id: mailboxes.id })
            .from(mailboxes)
            .where(eq(mailboxes.workspaceId, workspaceId)),
        ),
      ),
    )
    .returning({ threadId: drafts.threadId });
  if (!undone.length) return false;
  await db().insert(activityLog).values({
    workspaceId,
    actor: "owner",
    action: "send_undone",
    threadId: undone[0]!.threadId,
    detail: { draftId },
  });
  return true;
}

/** A claim older than this belongs to a run that died; another may take it. */
const SEND_CLAIM_LEASE_MS = 2 * 60_000;

/** Check 9 P2: the same for autopilot's claim (`drafts.auto_send_claimed_at`). */
export const AUTOPILOT_CLAIM_LEASE_MS = 2 * 60_000;

/** Check 9 P2: an autopilot run holds this draft right now (Hold it is too late). */
export const autopilotSending = (
  d: Pick<Draft, "autoSendAt" | "autoSendClaimedAt">,
  now: Date,
): boolean =>
  d.autoSendAt != null &&
  d.autoSendClaimedAt != null &&
  d.autoSendClaimedAt.getTime() > now.getTime() - AUTOPILOT_CLAIM_LEASE_MS;

export type DeliverResult =
  { status: "sent" } | { status: "not_due" } | { status: "stopped"; why: string };

/**
 * The undo window is over: claim the draft (only one runner ever can), run the
 * whole send — gate included, since the account can change in 20 seconds —
 * and send. Anything that stops it puts the draft back in the queue.
 */
export async function deliverQueuedSend(
  draftId: string,
  opts: DraftDeps = {},
): Promise<DeliverResult> {
  const now = opts.now?.() ?? new Date();
  const [claimed] = await db()
    .update(drafts)
    .set({ sendClaimedAt: now })
    .where(
      and(
        eq(drafts.id, draftId),
        eq(drafts.status, "pending"),
        isNotNull(drafts.sendAfter),
        lte(drafts.sendAfter, now),
        or(
          isNull(drafts.sendClaimedAt),
          lt(drafts.sendClaimedAt, new Date(now.getTime() - SEND_CLAIM_LEASE_MS)),
        ),
      ),
    )
    .returning({ mailboxId: drafts.mailboxId, threadId: drafts.threadId });
  if (!claimed) return { status: "not_due" };
  const [box] = await db()
    .select({ workspaceId: mailboxes.workspaceId })
    .from(mailboxes)
    .where(eq(mailboxes.id, claimed.mailboxId));
  const workspaceId = box!.workspaceId;

  let why: string;
  try {
    // The timing words were checked (or confirmed) at the tap, seconds ago: the owner's okay.
    const outcome = await sendDraft(workspaceId, draftId, {
      ...opts,
      queued: true,
      confirmedTiming: true,
    });
    if (outcome.status === "sent") return { status: "sent" };
    if (outcome.status === "answered_elsewhere") {
      // Check 42 P1: the customer was answered from Gmail during the undo window. The window
      // ends quietly: the reply is set aside (here and in Gmail), never sent.
      await standDownAnswered(draftId, workspaceId, claimed.threadId, opts, now);
      return { status: "stopped", why: "answered_elsewhere" };
    }
    why = outcome.status;
  } catch (err) {
    if (!(err instanceof SendingBlockedError)) throw err; // the claim lapses; a retry takes it
    why = "blocked";
  }
  await db()
    .update(drafts)
    .set({ sendAfter: null, sendClaimedAt: null })
    .where(and(eq(drafts.id, draftId), eq(drafts.status, "pending")));
  await db().insert(activityLog).values({
    workspaceId,
    actor: "squared_away",
    action: "send_stopped",
    threadId: claimed.threadId,
    detail: { draftId, why },
  });
  return { status: "stopped", why };
}

/**
 * Check 42 P1: a queued reply whose customer was answered from Gmail meanwhile. It is closed as
 * expired (only while still pending), its Gmail draft deleted (best effort), and one
 * content-free `send_stood_down` row says why.
 */
async function standDownAnswered(
  draftId: string,
  workspaceId: string,
  threadId: string,
  opts: DraftDeps,
  now: Date,
) {
  const [closed] = await db()
    .update(drafts)
    .set({
      status: "expired",
      closedNote: ANSWERED_ELSEWHERE_NOTE,
      decidedAt: now,
      sendAfter: null,
      sendClaimedAt: null,
    })
    .where(and(eq(drafts.id, draftId), eq(drafts.status, "pending")))
    .returning({ gmailDraftId: drafts.gmailDraftId, mailboxId: drafts.mailboxId });
  if (!closed) return;
  if (closed.gmailDraftId) {
    const [mailbox] = await db().select().from(mailboxes).where(eq(mailboxes.id, closed.mailboxId));
    try {
      if (mailbox)
        await (opts.writerFor ?? defaultWriter)(mailbox).deleteDraft(closed.gmailDraftId);
    } catch (err) {
      if (err instanceof MailboxAuthError && mailbox) await markReconnectNeeded(mailbox);
      else
        console.error("stood_down_gmail_delete_failed", {
          draftId,
          error: err instanceof Error ? err.name : "unknown",
        });
    }
  }
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: "squared_away",
      action: "send_stood_down",
      threadId,
      detail: { draftId, reason: "answered_elsewhere" },
    });
}

/** Check 42 P2: a waiting draft's current text, for the owner's own draft only. */
export async function pendingDraftText(workspaceId: string, draftId: string) {
  const row = await loadOwnedDraft(workspaceId, draftId);
  return row && row.draft.status === "pending" ? (row.draft.body ?? "") : null;
}

/** Check 42 P1: the Gmail link of a draft's conversation, for the owner's own draft only. */
export async function draftGmailLink(workspaceId: string, draftId: string) {
  const row = await loadOwnedDraft(workspaceId, draftId);
  return row
    ? gmailThreadLink({ mailboxEmail: row.mailbox.email, gmailThreadId: row.thread.gmailThreadId })
    : null;
}

/** Backstop for lost events: sends whose window ended a minute ago and nobody holds. */
export async function overdueQueuedSends(now: Date = new Date()): Promise<string[]> {
  const rows = await db()
    .select({ id: drafts.id })
    .from(drafts)
    .where(
      and(
        eq(drafts.status, "pending"),
        isNotNull(drafts.sendAfter),
        lte(drafts.sendAfter, new Date(now.getTime() - 60_000)),
        or(
          isNull(drafts.sendClaimedAt),
          lt(drafts.sendClaimedAt, new Date(now.getTime() - SEND_CLAIM_LEASE_MS)),
        ),
      ),
    )
    .limit(50);
  return rows.map((r) => r.id);
}

export type BatchRow = {
  draftId: string;
  /** Who it's for: the customer's name, else their address. */
  to: string;
  /** The address the reply goes to (H7). */
  toAddress: string;
  category: string;
  firstLine: string;
  /** Check 9 P1: the fingerprint of the text as the review page read it. */
  seenHash: string;
};

/** Plan #5: drafts that may be sent together, freshly read and filtered by the rules. */
export async function batchCandidates(
  workspaceId: string,
  picked: readonly string[],
  now: Date = new Date(),
): Promise<BatchRow[]> {
  const rows = await db()
    .select({ draft: drafts, thread: threads })
    .from(drafts)
    .innerJoin(threads, eq(threads.id, drafts.threadId))
    .innerJoin(mailboxes, eq(mailboxes.id, drafts.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        mailboxRunning(),
        eq(drafts.status, "pending"),
        isNull(drafts.sendAfter),
      ),
    )
    .orderBy(desc(threads.lastMessageAt));
  const out: BatchRow[] = [];
  for (const { draft, thread } of rows) {
    const extracted = (thread.extracted ?? {}) as {
      dollar_amounts?: number[];
      injection?: boolean;
      municipal?: boolean;
      accepts_quote?: boolean;
      payment_change?: boolean;
      gas_smell?: boolean;
      co_alarm?: boolean;
      electrical_hazard?: boolean;
      asks_if_ai?: boolean;
    };
    const ok = batchEligible(
      {
        category: thread.category,
        needsOwner: thread.needsOwner || thread.needsOwnerManual,
        flags: draft.flags,
        confidencePct: draft.confidence,
        body: draft.body ?? "",
        amountsInEmail: extracted.dollar_amounts ?? [],
        untrusted:
          extracted.injection === true ||
          extracted.municipal === true ||
          extracted.payment_change === true ||
          extracted.gas_smell === true ||
          extracted.co_alarm === true ||
          extracted.electrical_hazard === true ||
          // Check 48 P1: "is this a bot?", or a draft that says a person wrote it alone.
          extracted.asks_if_ai === true ||
          claimsHuman(draft.body ?? "") ||
          // Check 36 P2: an emergency in the last 48 hours, whatever the thread is now.
          recentEmergency(extracted, now),
        autopilotCounting: draft.autoSendAt !== null,
        acceptsQuote: extracted.accepts_quote === true,
        purpose: draft.purpose ?? null,
      },
      picked,
    );
    if (!ok) continue;
    const who = await customerOf(thread.id);
    out.push({
      draftId: draft.id,
      to: who?.name || who?.address || draft.toAddress,
      toAddress: draft.toAddress,
      category: thread.category!,
      firstLine: firstLine(draft.body ?? ""),
      seenHash: bodyHash(draft.body ?? ""),
    });
  }
  return out;
}

/**
 * Plan #5 "Send N replies": each requested draft is re-checked against the
 * rules on fresh rows (IDs from the browser prove nothing), then goes through
 * queueSend — the one gate, its own undo window, its own log entry.
 */
export async function batchSend(
  workspaceId: string,
  draftIds: readonly string[],
  picked: readonly string[],
  opts: DraftDeps & {
    device?: "phone" | "computer";
    /**
     * Check 9 P1: per draft, the fingerprint of the text and the address the review page showed.
     * When given, a draft with no entry, or one that changed since, is refused.
     */
    seen?: ReadonlyMap<string, { hash: string; to?: string }>;
  } = {},
): Promise<{ queued: { draftId: string; sendAfter: Date }[]; refused: number }> {
  const allowed = new Set(
    (await batchCandidates(workspaceId, picked, opts.now?.() ?? new Date())).map((r) => r.draftId),
  );
  const queued: { draftId: string; sendAfter: Date }[] = [];
  let refused = 0;
  for (const id of new Set(draftIds)) {
    const shown = opts.seen?.get(id);
    if (!allowed.has(id) || (opts.seen && !shown)) {
      refused++;
      continue;
    }
    // A blocked account throws here, on the first one, before any Gmail call.
    const { seen: _seen, ...rest } = opts;
    void _seen;
    const r = await queueSend(workspaceId, id, {
      ...rest,
      ...(shown ? { seenHash: shown.hash, seenTo: shown.to } : {}),
    });
    if (r.status === "queued") queued.push({ draftId: id, sendAfter: r.sendAfter });
    else refused++;
  }
  return { queued, refused };
}

/** Save the owner's edits to the Gmail draft without sending. */
/**
 * Check 42 P2: the Gmail draft's text differs from ours, so someone changed it there (the
 * office typed a price in). Their text becomes the draft's; any countdown or queued send stops.
 */
async function takeGmailText(draftId: string, text: string) {
  await db()
    .update(drafts)
    .set({ body: text, autoSendAt: null, sendAfter: null })
    .where(and(eq(drafts.id, draftId), eq(drafts.status, "pending")));
}

export type SaveEditOutcome =
  | "saved"
  | "not_found"
  | "deleted_in_gmail"
  | "reconnect_needed"
  | "mailbox_paused"
  /** Check 42 P2: changed in Gmail since; nothing written, the Gmail text is now the draft's. */
  | "changed_in_gmail"
  /** Check 42 P2: saved from another device since this editor opened; nothing written. */
  | "changed_since_opened"
  | GmailHiccup;

export async function saveDraftEdit(
  workspaceId: string,
  draftId: string,
  body: string,
  opts: DraftDeps & {
    /** Check 42 P2: bodyHash of the text the editor opened with. */
    openedHash?: string;
  } = {},
): Promise<SaveEditOutcome> {
  const row = await loadOwnedDraft(workspaceId, draftId);
  if (!row || row.draft.status !== "pending" || !row.draft.gmailDraftId || row.draft.sendAfter)
    return "not_found";
  const { draft, mailbox, thread, workspace } = row;
  const now = opts.now?.() ?? new Date();
  if (!jobsAllowed(workspace, now)) throw new ReadOnlyError(effectiveStatus(workspace, now));
  if (mailbox.planPausedAt) return "mailbox_paused";
  if (opts.openedHash !== undefined && opts.openedHash !== bodyHash(draft.body ?? ""))
    return "changed_since_opened";
  const writer = (opts.writerFor ?? defaultWriter)(mailbox);
  try {
    const remote = await writer.getDraft(draft.gmailDraftId!);
    if (!remote) {
      await closeDraft(
        draft,
        workspaceId,
        "discarded",
        "You deleted or sent this draft in Gmail.",
        now,
      );
      return "deleted_in_gmail";
    }
    if (!sameText(remote.bodyText, draft.body)) {
      await takeGmailText(draft.id, remote.bodyText);
      return "changed_in_gmail";
    }
    await writer.updateDraft(draft.gmailDraftId!, {
      threadId: thread.gmailThreadId,
      raw: mimeFor(draft, mailbox, body.trim(), await replyToHeaders(draft)),
    });
    // The owner touched it, so it waits for their tap — autopilot stands down.
    await db()
      .update(drafts)
      .set({ body: body.trim(), autoSendAt: null })
      .where(eq(drafts.id, draft.id));
    return "saved";
  } catch (err) {
    if (err instanceof MailboxAuthError) {
      await markReconnectNeeded(mailbox);
      return "reconnect_needed";
    }
    return gmailHiccup(err, "save_edit", draft.id);
  }
}

export type ReviseOutcome =
  | { status: "revised"; flags: string[] }
  | { status: "limit" }
  /** "Other ways to reply" asked of a draft that isn't a first reply (replies package). */
  | { status: "not_first_contact" }
  | { status: "model_failed" }
  | { status: "capped" }
  | { status: "deleted_in_gmail" }
  | { status: "reconnect_needed" }
  | { status: "mailbox_paused" }
  /** Check 42 P2: changed in Gmail (or on another device) since; nothing rewritten. */
  | { status: "changed_in_gmail" }
  | { status: "changed_since_opened" }
  | { status: GmailHiccup }
  | { status: "not_found" };

/**
 * Quick tweaks and voice edits (plan #3, #4): rewrite a pending draft with the
 * same guardrails as a new one — the #43 checks run on the new text (a
 * tweak can't hide a problem the check would raise), an invented price or
 * date gets one more try, then a flag. The Gmail draft is updated; nothing is
 * sent. At most MAX_REVISIONS_PER_DRAFT per draft.
 */
export async function reviseDraft(
  workspaceId: string,
  draftId: string,
  change: { tweak: Tweak } | { spoken: string } | { opening: OpeningTweak },
  opts: DraftDeps & {
    /** Check 42 P2: bodyHash of the text the card showed when the change was asked for. */
    openedHash?: string;
  } = {},
): Promise<ReviseOutcome> {
  const row = await loadOwnedDraft(workspaceId, draftId);
  if (!row || row.draft.status !== "pending" || !row.draft.gmailDraftId || row.draft.sendAfter)
    return { status: "not_found" };
  const { draft, mailbox, thread, workspace } = row;
  const now = opts.now?.() ?? new Date();
  if (!jobsAllowed(workspace, now)) throw new ReadOnlyError(effectiveStatus(workspace, now));
  if (mailbox.planPausedAt) return { status: "mailbox_paused" };
  if (mailbox.status !== "active") return { status: "reconnect_needed" };
  if (draft.revisions >= MAX_REVISIONS_PER_DRAFT) return { status: "limit" };
  // Replies package: "Other ways to reply" is for a first reply to a new lead only.
  const opening = "opening" in change ? change.opening : null;
  if (
    opening !== null &&
    !(isFirstContactOpening(draft.opening) && draft.kind === "reply" && !draft.purpose)
  )
    return { status: "not_first_contact" };
  // Check 42 P2: a change asked of text that has moved on (another device, or Gmail) is never
  // made: both are checked before the model is called, so its rewrite can't wipe theirs.
  if (opts.openedHash !== undefined && opts.openedHash !== bodyHash(draft.body ?? ""))
    return { status: "changed_since_opened" };
  const writer = (opts.writerFor ?? defaultWriter)(mailbox);
  const gmailMoved = async (): Promise<ReviseOutcome | null> => {
    const remote = await writer.getDraft(draft.gmailDraftId!);
    if (!remote) {
      await closeDraft(
        draft,
        workspaceId,
        "discarded",
        "You deleted or sent this draft in Gmail.",
        now,
      );
      return { status: "deleted_in_gmail" };
    }
    if (!sameText(remote.bodyText, draft.body)) {
      await takeGmailText(draft.id, remote.bodyText);
      return { status: "changed_in_gmail" };
    }
    return null;
  };
  try {
    const moved = await gmailMoved();
    if (moved) return moved;
  } catch (err) {
    if (err instanceof MailboxAuthError) {
      await markReconnectNeeded(mailbox);
      return { status: "reconnect_needed" };
    }
    return { status: gmailHiccup(err, "revise", draft.id) };
  }

  const spoken = "spoken" in change ? change.spoken.trim().slice(0, 500) : null;
  const dispute = disputeThread(thread);
  const ask =
    spoken ??
    (opening !== null
      ? OPENING_TWEAKS[opening].ask
      : TWEAKS[(change as { tweak: Tweak }).tweak].ask);

  const recent = (
    await db()
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.threadId, draft.threadId),
          lte(messages.sentAt, draft.createdAt),
          notDraftMessage(),
        ),
      )
      .orderBy(desc(messages.sentAt))
      .limit(CONVERSATION_MESSAGES)
  ).reverse();
  const withText = recent
    .map((m) => ({
      m,
      text: prepareBody(m.bodyText ?? m.snippet ?? "").slice(0, PER_MESSAGE_CHARS),
    }))
    .filter((x) => x.text.length > 0);
  const ctx = await workspaceContext(workspace.id, workspace, now);
  const ownerFacts = [
    ctx.pricingNotes,
    ctx.hours,
    ctx.leadTime,
    ctx.policies,
    ctx.paymentTerms,
    ctx.services,
    ctx.signature,
    // Check 38 P6: the saved license numbers are the owner's own words.
    licenseFacts(ctx.licenses),
    ...ctx.seasonalNotes.map((n) => n.text),
    // Check 23 P3: a seasonal note's last day, as a draft would write it ("November 27").
    ...ctx.seasonalNotes.map((n) => spellDate(n.endsOn)),
    // What the owner said counts as a fact they gave us (plan #4).
    spoken,
    // Facts already in a clean draft stay allowed. A flagged draft's text
    // doesn't count, so a tweak can never launder a flag away.
    (draft.flags ?? []).length === 0 ? draft.body : null,
  ];
  const lastInbound = [...withText].reverse().find((x) => x.m.direction === "in");
  const checkContext = {
    sourceText: [withText.map((x) => x.text).join("\n"), ...ownerFacts].filter(Boolean).join("\n"),
    // Check 23 P3: "Add my availability" writes the hours on purpose, so their days count.
    ...whenContext(
      ctx,
      withText,
      [spoken, (draft.flags ?? []).length === 0 ? draft.body : null],
      now,
      ("tweak" in change && change.tweak === "availability") ||
        asksWhenAvailable(lastInbound?.text ?? ""),
    ),
    // Round 2 A4: an amount only the customer named isn't the owner's price.
    ownerSourceText: [
      ...withText.filter((x) => x.m.direction === "out").map((x) => x.text),
      ...ownerFacts,
    ]
      .filter(Boolean)
      .join("\n"),
    // Round 2 A5: "tell her Thursday works, 450" — every number the owner said is theirs.
    ownerInstruction: spoken,
    doNotPromise: ctx.doNotPromise,
    phrasesAvoided: ctx.voice?.phrasesAvoided ?? [],
    neverSay: ctx.neverSay,
    licenses: ctx.licenses,
    state: ctx.state,
    // Check 23 P14: hold the price list's "from" and the job each price is for.
    priceList: ctx.pricingNotes,
    // Check 23 P13: a first reply's "Thanks for reaching out" isn't filler.
    firstContact: isFirstContactOpening(draft.opening) && draft.kind === "reply" && !draft.purpose,
    // Check 23 P6: the names on the conversation's From lines may be used.
    knownNames: withText
      .flatMap(({ m }) => [m.fromName, customerReplyName(m)])
      .filter((n): n is string => !!n),
    // Check 23 P5: the light payment-terms check on every reply; what the owner said and a
    // clean draft's text count as theirs.
    termsSource: [ownerTerms(ctx), spoken].filter(Boolean).join("\n"),
    ownerWrote: [
      ...withText.filter((x) => x.m.direction === "out").map((x) => x.text),
      (draft.flags ?? []).length === 0 ? draft.body : null,
    ]
      .filter(Boolean)
      .join("\n"),
    // A tweak on a deposit or review note keeps the terms check (A4): "friendlier" can't add
    // Venmo or "10% off". What the owner said, and a clean draft's text, are theirs.
    ...termsCheck(draft.purpose, ctx, {
      wrote: [
        ...withText.filter((x) => x.m.direction === "out").map((x) => x.text),
        (draft.flags ?? []).length === 0 ? draft.body : null,
      ],
      terms: [spoken],
    }),
  };
  const convo = conversationBlock({
    now,
    timeZone: ctx.timeZone,
    subject: thread.subject,
    category: thread.category,
    summary: thread.summary,
    extracted: thread.extracted,
    // Check 43 P9: a change on a dispute or legal thread keeps the same fixed caution.
    task: dispute
      ? `${reviseTask(draft.body ?? "", ask, spoken !== null)}\n\n${DISPUTE_TASK}`
      : reviseTask(draft.body ?? "", ask, spoken !== null),
    messages: withText.map(({ m, text }) => ({
      from:
        m.direction === "out"
          ? mailbox.email
          : (customerReplyName(m) ?? customerReplyAddress(m) ?? "customer"),
      direction: m.direction,
      sentAt: m.sentAt,
      body: text,
    })),
  });
  const request = {
    workspaceId: workspace.id,
    role: "draft" as const,
    promptVersion: `${
      opening !== null
        ? `${REVISE_PROMPT_VERSION}+${OPENING_TWEAKS_PROMPT_VERSION}`
        : REVISE_PROMPT_VERSION
    }${dispute ? `+${DISPUTE_CAUTION_PROMPT_VERSION}` : ""}`,
    maxTokens: 4096,
    effort: "medium" as const,
    mode: opts.aiMode ?? ("job" as const),
    system: [
      { text: REVISE_INSTRUCTIONS, cache: false },
      { text: workspaceBlock(ctx), cache: true },
    ],
    user: convo,
    schema: draftSchema,
    now,
  };
  let result;
  try {
    result = (await callStructured(request)) ?? (await callStructured(request));
    if (result?.body.trim()) {
      const first = checkDraft(result.body.trim(), checkContext);
      if (first.hits.some((h) => REGENERATE_ON.includes(h))) {
        const retry = await callStructured({
          ...request,
          user: `${convo}\n\nYour last attempt broke the owner's rules: ${first.flags.join(" ")} Write it again without that.`,
        });
        if (retry?.body.trim()) result = retry;
      }
    }
  } catch (err) {
    if (err instanceof AiCapReachedError) return { status: "capped" };
    throw err;
  }
  if (!result || !result.body.trim()) return { status: "model_failed" };

  // The same purpose guards as a new draft: a tweak can't drop the deposit gap or the review
  // link, nor lift their flags and confidence cap.
  const { body, flags: purposeFlags } = purposeGuards(draft.purpose, result.body.trim(), ctx);
  // Where it goes doesn't change with a tweak: a no-reply or moved address stays flagged.
  const addressFlags = [
    ...(isNoReplyAddress(draft.toAddress) ? [NO_REPLY_FLAG] : []),
    ...((draft.flags ?? []).includes(REPOINTED_FLAG) ? [REPOINTED_FLAG] : []),
  ];
  const scored = scoreDraft(result, checkDraft(body, checkContext), [
    ...addressFlags,
    ...purposeFlags,
  ]);
  // Check 43 P9: a tweak never lifts the caution or its cap (nor Check 38 P1's reminder).
  const fixedFlags = [
    ...(dispute ? [DISPUTE_FLAG] : []),
    ...((draft.flags ?? []).includes(CHANGE_ORDER_FLAG) ? [CHANGE_ORDER_FLAG] : []),
  ];
  const flags = [...new Set([...fixedFlags, ...scored.flags])].slice(0, 6);
  const confidence = dispute
    ? Math.min(scored.confidence, Math.round(DISPUTE_CONFIDENCE_CAP * 100))
    : scored.confidence;

  try {
    // Again after the model's few seconds: someone may have typed in Gmail meanwhile.
    const moved = await gmailMoved();
    if (moved) return moved;
    await writer.updateDraft(draft.gmailDraftId!, {
      threadId: thread.gmailThreadId,
      raw: mimeFor(draft, mailbox, body, await replyToHeaders(draft)),
    });
  } catch (err) {
    if (err instanceof MailboxAuthError) {
      await markReconnectNeeded(mailbox);
      return { status: "reconnect_needed" };
    }
    return { status: gmailHiccup(err, "revise", draft.id) };
  }
  await db()
    .update(drafts)
    .set({
      body,
      flags,
      confidence,
      reason: result.reason.trim().slice(0, 200) || draft.reason,
      usedFacts: [...new Set(result.used_facts ?? [])],
      revisions: sql`${drafts.revisions} + 1`,
      // The owner changed it, so autopilot stands down.
      autoSendAt: null,
    })
    .where(eq(drafts.id, draft.id));
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: "owner",
      action: "draft_revised",
      threadId: draft.threadId,
      // Content-free: which tweak, or that it was spoken — never the words.
      detail: {
        draftId: draft.id,
        via:
          spoken !== null
            ? "voice"
            : opening !== null
              ? `opening_${opening}`
              : (change as { tweak: Tweak }).tweak,
      },
    });
  return { status: "revised", flags };
}

async function closeDraft(
  d: Pick<Draft, "id" | "threadId">,
  workspaceId: string,
  status: "discarded" | "expired" | "sent",
  note: string | null,
  now: Date,
  actor: "owner" | "squared_away" = "squared_away",
) {
  await db()
    .update(drafts)
    .set({ status, closedNote: note, decidedAt: now })
    .where(eq(drafts.id, d.id));
  await logClosed(d, workspaceId, status, actor);
}

async function logClosed(
  d: Pick<Draft, "id" | "threadId">,
  workspaceId: string,
  status: "discarded" | "expired" | "sent",
  actor: "owner" | "squared_away",
) {
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor,
      action:
        status === "discarded"
          ? "draft_discarded"
          : status === "expired"
            ? "draft_expired"
            : "reply_sent_from_gmail",
      threadId: d.threadId,
      detail: { draftId: d.id },
    });
}

/** Throw the draft away here and in Gmail. */
export async function discardDraft(
  workspaceId: string,
  draftId: string,
  opts: DraftDeps = {},
): Promise<"discarded" | "not_found" | GmailHiccup> {
  const row = await loadOwnedDraft(workspaceId, draftId);
  if (!row || row.draft.status !== "pending" || row.draft.sendAfter) return "not_found";
  const now = opts.now?.() ?? new Date();
  if (!jobsAllowed(row.workspace, now))
    throw new ReadOnlyError(effectiveStatus(row.workspace, now));
  const writer = (opts.writerFor ?? defaultWriter)(row.mailbox);
  if (row.draft.gmailDraftId) {
    try {
      await writer.deleteDraft(row.draft.gmailDraftId);
    } catch (err) {
      // Check 9 P3: Gmail didn't answer. The draft stays here and in Gmail; try again.
      if (!(err instanceof MailboxAuthError)) return gmailHiccup(err, "discard", row.draft.id);
      await markReconnectNeeded(row.mailbox);
    }
  }
  await closeDraft(row.draft, workspaceId, "discarded", null, now, "owner");
  return "discarded";
}

/** A nudge still waiting for the owner: pending, and not already tapped Send (undo window). */
const waitingNudge = (threadId: string) =>
  and(
    eq(drafts.threadId, threadId),
    eq(drafts.kind, "followup"),
    eq(drafts.status, "pending"),
    isNull(drafts.sendAfter),
  );

/**
 * The owner closed the matter (decided the quote, marked the invoice paid or not owed), so the
 * thread's waiting nudge goes — here and in Gmail. A nudge already tapped Send is the owner's
 * call and is left alone. The nudge always closes here: lost Google access → reconnect
 * banner; any other Gmail failure (rate limit, outage) or a mailbox that isn't working →
 * the Gmail draft is left in Gmail, as on the reconnect path. Returns whether one was closed.
 *
 * The row is claimed first, in one conditional UPDATE (still pending, Send not tapped), and
 * only the call that claimed it touches Gmail or writes Activity: a Send tapped a moment
 * earlier on another device wins, and a double-submitted "Mark paid" closes it once.
 */
export async function expirePendingNudge(
  threadId: string,
  note: string,
  opts: DraftDeps = {},
): Promise<boolean> {
  return expireWaiting(waitingNudge(threadId), note, opts);
}

/**
 * Round 2 (FW E11): the owner answered by phone, so whatever draft waits on the thread (a reply
 * or a nudge) goes, here and in Gmail — the same claim-first rules as `expirePendingNudge`. A
 * reply already tapped Send (in its undo window) is left alone.
 */
export async function expirePendingDraft(
  threadId: string,
  note: string,
  opts: DraftDeps = {},
): Promise<boolean> {
  return expireWaiting(
    and(eq(drafts.threadId, threadId), eq(drafts.status, "pending"), isNull(drafts.sendAfter))!,
    note,
    opts,
  );
}

/**
 * Ideas H4: the owner moved an undecided quote to another kind, so a waiting deposit note (the
 * thread's acceptance no longer counts) goes, here and in Gmail. Same claim-first rules.
 */
export async function expireWaitingDeposit(threadId: string, opts: DraftDeps = {}) {
  return expireWaiting(
    and(
      eq(drafts.threadId, threadId),
      eq(drafts.purpose, "deposit"),
      eq(drafts.status, "pending"),
      isNull(drafts.sendAfter),
    )!,
    "You moved this away from quote requests, so the deposit note was withdrawn.",
    opts,
  );
}

async function expireWaiting(
  where: ReturnType<typeof and>,
  note: string,
  opts: DraftDeps,
): Promise<boolean> {
  const now = opts.now?.() ?? new Date();
  const [claimed] = await db()
    .update(drafts)
    .set({ status: "expired", closedNote: note, decidedAt: now })
    .where(where)
    .returning({
      id: drafts.id,
      threadId: drafts.threadId,
      gmailDraftId: drafts.gmailDraftId,
      mailboxId: drafts.mailboxId,
    });
  if (!claimed) return false;
  const [mailbox] = await db().select().from(mailboxes).where(eq(mailboxes.id, claimed.mailboxId));
  const row = { draft: claimed, mailbox };
  if (row.draft.gmailDraftId && row.mailbox.status === "active") {
    try {
      await (opts.writerFor ?? defaultWriter)(row.mailbox).deleteDraft(row.draft.gmailDraftId);
    } catch (err) {
      if (err instanceof MailboxAuthError) {
        await markReconnectNeeded(row.mailbox);
      } else {
        // Metadata only.
        console.error("nudge_gmail_delete_failed", {
          workspaceId: row.mailbox.workspaceId,
          draftId: row.draft.id,
          error: err instanceof Error ? err.name : "unknown",
        });
      }
    }
  }
  await logClosed(row.draft, row.mailbox.workspaceId, "expired", "squared_away");
  return true;
}

/**
 * Our own guess closed the matter (a quote outcome, or an invoice we think was paid).
 * A guess never deletes anything: the waiting nudge stays, with a flag asking the owner to
 * check, and any autopilot countdown is cleared. Idempotent.
 */
export async function flagPendingNudge(threadId: string, flag: string): Promise<boolean> {
  const rows = await db()
    .update(drafts)
    .set({
      flags: sql`case when ${drafts.flags} @> jsonb_build_array(${flag}::text) then ${drafts.flags} else ${drafts.flags} || jsonb_build_array(${flag}::text) end`,
      autoSendAt: null,
    })
    .where(waitingNudge(threadId))
    .returning({ id: drafts.id });
  return rows.length > 0;
}

/** Takes a flag back off the thread's waiting nudge (the owner said otherwise). Idempotent. */
export async function unflagPendingNudge(threadId: string, flag: string): Promise<boolean> {
  const rows = await db()
    .update(drafts)
    .set({ flags: sql`${drafts.flags} - ${flag}::text` })
    .where(and(waitingNudge(threadId), sql`${drafts.flags} @> jsonb_build_array(${flag}::text)`))
    .returning({ id: drafts.id });
  return rows.length > 0;
}

/**
 * Check 14 P1: our Gmail draft is gone and the shop wrote on the thread since. Which email
 * was it? Our draft sent from Gmail (its message id, or the same text) → sent via `gmail`
 * (`edited_and_sent` when Gmail kept the id but the text changed). Anything else is the owner's
 * own reply: status stays `sent` (so the two-nudge cap and the thread stay as before) but
 * `sent_via = own_words`, which never counts as a drafted reply sent or as time saved, and
 * Activity says "You answered Dana yourself in Gmail". decidedAt = when that email went.
 */
async function closeSentFromGmail(
  d: Draft,
  workspaceId: string,
  outs: { gmailMessageId: string; sentAt: Date; bodyText: string | null }[],
) {
  const same = (m: { bodyText: string | null }) =>
    m.bodyText != null && d.body != null && sameText(prepareBody(m.bodyText), d.body);
  const byId = d.gmailMessageId ? outs.find((m) => m.gmailMessageId === d.gmailMessageId) : null;
  const match = byId ?? outs.find(same) ?? null;
  const newest = outs.reduce((a, b) => (b.sentAt > a.sentAt ? b : a));
  const ownWords = match == null;
  // Gmail kept our draft's id but the text is different: edited there, then sent. A purged
  // text can't be compared; it counts as sent as written.
  const status: "sent" | "edited_and_sent" =
    byId && byId.bodyText != null && !same(byId) ? "edited_and_sent" : "sent";
  await db()
    .update(drafts)
    .set({
      status,
      sentVia: ownWords ? "own_words" : "gmail",
      closedNote: ownWords ? "You answered them yourself in Gmail." : "You sent this from Gmail.",
      decidedAt: (match ?? newest).sentAt,
    })
    .where(eq(drafts.id, d.id));
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: "owner",
      action: ownWords ? "owner_wrote_own_reply" : "reply_sent_from_gmail",
      threadId: d.threadId,
      detail: { draftId: d.id },
    });
}

/**
 * Keep the queue honest about what happened in Gmail:
 * - draft gone and the owner replied in the thread → they sent it from Gmail;
 * - draft gone otherwise → they deleted it;
 * - a newer customer message arrived → this reply is stale; expire it (and
 *   remove it from Gmail) so a fresh one can be written;
 * - text changed in Gmail → take their version.
 */
export async function reconcileDrafts(mailboxId: string, opts: DraftDeps = {}) {
  const now = opts.now?.() ?? new Date();
  const [box] = await db()
    .select({ mailbox: mailboxes, workspace: workspaces })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(eq(mailboxes.id, mailboxId));
  // Read-only workspaces (and paused or lost mailboxes) are left exactly as they are, here and
  // in Gmail.
  if (!box || !mailboxOn(box.mailbox) || !jobsAllowed(box.workspace, now))
    return { checked: 0, closed: 0, expiredThreads: [] as string[] };
  const { mailbox } = box;
  const pending = await db()
    .select()
    .from(drafts)
    .where(and(eq(drafts.mailboxId, mailboxId), eq(drafts.status, "pending")))
    .orderBy(asc(drafts.createdAt));
  const writer = (opts.writerFor ?? defaultWriter)(mailbox);
  let closed = 0;
  const expiredThreads: string[] = [];
  try {
    for (const d of pending) {
      // The send job holds this one right now; it does its own checks.
      if (d.sendClaimedAt) continue;
      // Leads package: a draft older code wrote to an email-to-text gateway or to a lead
      // website's robot can never go; expire it (and its Gmail draft) like an out-of-date one.
      if (isEmailToTextAddress(d.toAddress) || channelOf(d.toAddress)?.kind === "site") {
        if (d.gmailDraftId) await writer.deleteDraft(d.gmailDraftId);
        await closeDraft(
          d,
          mailbox.workspaceId,
          "expired",
          isEmailToTextAddress(d.toAddress)
            ? TEXT_ADDRESS_NOTE
            : "That was a lead website's notice — answer them on the website.",
          now,
        );
        closed++;
        continue;
      }
      const newer = await db()
        .select({
          direction: messages.direction,
          gmailMessageId: messages.gmailMessageId,
          sentAt: messages.sentAt,
          bodyText: messages.bodyText,
        })
        .from(messages)
        .where(
          and(
            eq(messages.threadId, d.threadId),
            gt(messages.sentAt, d.createdAt),
            // An unsent Gmail draft (an edit of this one, or the owner's own) isn't mail sent.
            notDraftMessage(),
          ),
        );
      if (newer.some((m) => m.direction === "in")) {
        if (d.gmailDraftId) await writer.deleteDraft(d.gmailDraftId);
        await closeDraft(
          d,
          mailbox.workspaceId,
          "expired",
          "The customer wrote again, so this reply was out of date.",
          now,
        );
        expiredThreads.push(d.threadId);
        closed++;
        continue;
      }
      const remote = d.gmailDraftId ? await writer.getDraft(d.gmailDraftId) : null;
      if (!remote) {
        const outs = newer.filter((m) => m.direction === "out");
        const ownerReplied = outs.length > 0;
        if (ownerReplied) await closeSentFromGmail(d, mailbox.workspaceId, outs);
        else
          await closeDraft(
            d,
            mailbox.workspaceId,
            "discarded",
            "You deleted this draft in Gmail.",
            now,
            "owner",
          );
        if (ownerReplied) {
          await db()
            .update(threads)
            .set({ awaitingReplySince: now, needsOwner: false, needsOwnerManual: false })
            .where(eq(threads.id, d.threadId));
        }
        closed++;
      } else if (
        (d.kind === "followup" ||
          d.purpose === "closing_question" ||
          d.purpose === "review_request" ||
          isThankYou(d.purpose)) &&
        newer.some((m) => m.direction === "out")
      ) {
        // The owner wrote to them some other way since; this nudge or note would repeat it.
        await writer.deleteDraft(d.gmailDraftId!);
        await closeDraft(
          d,
          mailbox.workspaceId,
          "expired",
          d.kind === "followup"
            ? "You wrote to them since, so this nudge was out of date."
            : "You wrote to them since, so this note was out of date.",
          now,
        );
        closed++;
      } else if (
        d.kind === "reply" &&
        (await answeredSince(d.threadId, d.createdAt, mailbox.email)) !== null
      ) {
        // Check 42 P1: someone answered the customer from Gmail since this was written (the
        // office, or the owner at a computer). A second answer would go out, so it is set aside.
        await writer.deleteDraft(d.gmailDraftId!);
        await closeDraft(d, mailbox.workspaceId, "expired", ANSWERED_ELSEWHERE_NOTE, now);
        closed++;
      } else if (!sameText(remote.bodyText, d.body)) {
        // Changed in Gmail: the owner hasn't approved this text, so any send stops too.
        await db()
          .update(drafts)
          .set({ body: remote.bodyText, autoSendAt: null, sendAfter: null })
          .where(eq(drafts.id, d.id));
      }
    }
  } catch (err) {
    if (err instanceof MailboxAuthError) {
      await markReconnectNeeded(mailbox);
      return { checked: pending.length, closed, expiredThreads };
    }
    throw err;
  }
  return { checked: pending.length, closed, expiredThreads };
}

export type QueueItem = {
  draftId: string | null;
  /** Check 43 P7: when the draft was written (its time words are read against it). */
  draftCreatedAt: Date | null;
  kind: "reply" | "followup" | null;
  /** Deposit details / review request / closing question (plan #26 #28 #29). Null = ordinary. */
  purpose: DraftPurpose | null;
  /** Autopilot will send this at this time unless held. */
  autoSendAt: Date | null;
  threadId: string;
  customerName: string | null;
  customerAddress: string | null;
  /** The address this draft goes to (H7: shown on every card). Null on needs-you items. */
  toAddress: string | null;
  /** The customer's email gave a Reply-To (a website form): the reply goes there, not to From. */
  replyRedirected: boolean;
  category: string | null;
  summary: string | null;
  needsOwnerReason: string | null;
  reason: string | null;
  body: string | null;
  flags: string[];
  confidence: number | null;
  /** Profile facts / voice traits the drafter relied on (keys). */
  usedFacts: string[];
  /** Replies package (draft.v7): a first reply's shape (a key), else null. */
  opening: string | null;
  /** Quick tweaks / voice edits left on this draft (plan #3, #4). */
  revisionsLeft: number;
  /** Plan #6: high priority and needs the owner — snooze only until tonight. */
  emergency: boolean;
  /** Plan #6: came back from a snooze — shown on top. */
  backFromSnooze: boolean;
  gmailThreadId: string;
  mailboxEmail: string;
  lastMessageAt: Date | null;
  /** When the customer's newest email was written (round 2, FW E9: shown on every card). */
  customerWroteAt: Date | null;
  /** Leads package: where the lead came from (`threads.lead_channel`), or null. */
  leadChannel: string | null;
  /** Leads package: the thread's stored facts, read by the card (lane, town, rule hits). */
  extracted: unknown;
  /** Leads package (B5): an emergency from someone with a job — the lane on top. */
  lane: boolean;
  /** Leads package (G5): a fixed complaint's "Check in" card, not the email itself. */
  checkIn: boolean;
  /** G5: when the owner marked it fixed. */
  complaintFixedAt: Date | null;
  /**
   * 2026-10-16: its Gmail address is paused on the plan — shown, but nothing is sent, drafted
   * or changed from it (MAILBOX_PAUSED_LINE).
   */
  mailboxPaused: boolean;
};

/** Plan #6: back from a snooze within the last day — pinned on top. */
const backFromSnoozeAt = (snoozedUntil: Date | null, now: Date) =>
  !!snoozedUntil && snoozedUntil <= now && now.getTime() - snoozedUntil.getTime() < BACK_ON_TOP_MS;

/** One queue entry with no content: ids, category, flags and times only (plan M8 A1). */
export type QueueMember = {
  threadId: string;
  category: string | null;
  /** Plan #6: high priority and needs the owner. */
  emergency: boolean;
  backFromSnooze: boolean;
  lastMessageAt: Date | null;
  /** Leads package (B5): in the emergency lane (needs-you only; sorted first). */
  lane: boolean;
  /** Leads package (G5): a check-in two days after "Mark fixed". */
  checkIn: boolean;
  /**
   * Integration 2026-10-17: its Gmail address is paused on the plan. Still a card on the queue
   * (marked paused), but never in a count: the owner can't act on it (`countQueue`,
   * `actionableQueue`).
   */
  paused: boolean;
};
export type QueueMembership = {
  /** `waitingSince`: the customer's first email since the owner last wrote (plan M8 A14). */
  needsYou: (QueueMember & { waitingSince: Date | null })[];
  drafts: (QueueMember & { draftId: string; kind: "reply" | "followup" })[];
};

/**
 * Who is on the queue, and nothing else (plan M8 A1): the same rules the queue screen uses —
 * needs the owner, in the inbox, no draft waiting, not snoozed; drafts pending and not in
 * their undo window (plan #7), not snoozed; items back from a snooze first. It selects only
 * ids, category, priority, kind and times — no names, addresses, summaries, reasons, bodies
 * or mailbox rows — so the morning summary, phone notifications and the badge can count from
 * it without ever holding an email's content. No row cap: totals are real totals (A19).
 */
export async function queueMembership(
  workspaceId: string,
  now: Date = new Date(),
): Promise<QueueMembership> {
  const boxes = await db()
    .select({ id: mailboxes.id, planPausedAt: mailboxes.planPausedAt })
    .from(mailboxes)
    .where(eq(mailboxes.workspaceId, workspaceId));
  const boxIds = boxes.map((b) => b.id);
  if (boxIds.length === 0) return { needsYou: [], drafts: [] };
  const pausedBoxes = new Set(boxes.filter((b) => b.planPausedAt).map((b) => b.id));

  const threadCols = {
    threadId: threads.id,
    mailboxId: threads.mailboxId,
    category: threads.category,
    priority: threads.priority,
    needsOwner: threads.needsOwner,
    snoozedUntil: threads.snoozedUntil,
    lastMessageAt: threads.lastMessageAt,
    // Content-free marks only (leads package, B5): never the email's facts.
    urgency: sql<string | null>`${threads.extracted}->>'urgency'`,
    injection: sql<string | null>`${threads.extracted}->>'injection'`,
  };
  const pending = await db()
    .select({ draftId: drafts.id, kind: drafts.kind, ...threadCols })
    .from(drafts)
    .innerJoin(threads, eq(threads.id, drafts.threadId))
    .where(
      and(
        inArray(drafts.mailboxId, boxIds),
        eq(drafts.status, "pending"),
        // In its undo window (plan #7): shown on the sent screen, not here.
        isNull(drafts.sendAfter),
      ),
    )
    .orderBy(desc(threads.lastMessageAt));
  // Every pending draft's thread counts as handled for "Needs you", snoozed or not.
  const draftedThreads = new Set(pending.map((r) => r.threadId));
  const needs = (
    await db()
      .select({ ...threadCols, waitingSince: waitingSinceSql() })
      .from(threads)
      .where(
        and(
          inArray(threads.mailboxId, boxIds),
          eq(threads.needsOwner, true),
          eq(threads.inInbox, true),
          // "I called them" (round 2, FW E11): answered, until the customer writes again.
          sql`not ${answeredByPhoneSql()}`,
        ),
      )
      .orderBy(desc(threads.lastMessageAt))
  ).filter((t) => !draftedThreads.has(t.threadId));
  // Leads package (G5): a complaint the owner marked fixed 2–30 days ago, with no word from
  // the customer since and the check-in not closed: "Check they're happy?". No draft waiting.
  const checkIns = (
    await db()
      .select(threadCols)
      .from(threads)
      .where(
        and(
          inArray(threads.mailboxId, boxIds),
          eq(threads.inInbox, true),
          isNotNull(threads.complaintFixedAt),
          lte(threads.complaintFixedAt, new Date(now.getTime() - CHECKIN_AFTER_DAYS * 86_400_000)),
          gt(threads.complaintFixedAt, new Date(now.getTime() - CHECKIN_MAX_DAYS * 86_400_000)),
          sql`(${threads.complaintCheckinDoneAt} is null or ${threads.complaintCheckinDoneAt} < ${threads.complaintFixedAt})`,
          sql`not exists (select 1 from messages ci where ci.thread_id = ${threads.id} and ci.direction = 'in' and ci.sent_at > ${threads.complaintFixedAt})`,
          // The owner already checked in by email (from Gmail, or a reply sent from here).
          sql`not exists (select 1 from messages co where co.thread_id = ${threads.id} and co.direction = 'out' and ${notDraftSql("co")} and not ${sideEmailSql("co")} and co.sent_at > ${threads.complaintFixedAt})`,
          sql`not exists (select 1 from drafts cd where cd.thread_id = ${threads.id} and cd.status in ('sent', 'edited_and_sent') and cd.decided_at > ${threads.complaintFixedAt})`,
        ),
      )
      .orderBy(desc(threads.complaintFixedAt))
  ).filter((t) => !draftedThreads.has(t.threadId) && !needs.some((n) => n.threadId === t.threadId));

  const snoozed = (t: { snoozedUntil: Date | null }) => !!t.snoozedUntil && t.snoozedUntil > now;
  const member = (
    t: (typeof pending)[number] | (typeof needs)[number] | (typeof checkIns)[number],
  ): QueueMember => ({
    threadId: t.threadId,
    category: t.category,
    emergency: isEmergency(t),
    backFromSnooze: backFromSnoozeAt(t.snoozedUntil, now),
    lastMessageAt: t.lastMessageAt,
    lane: false,
    checkIn: false,
    paused: pausedBoxes.has(t.mailboxId),
  });
  // A stable sort: newest first, with anything back from a snooze on top — and the emergency
  // lane above everything (leads package, B5).
  const backFirst = <T extends QueueMember>(rows: T[]) =>
    [...rows].sort(
      (a, b) =>
        Number(b.lane) - Number(a.lane) || Number(b.backFromSnooze) - Number(a.backFromSnooze),
    );

  return {
    needsYou: backFirst([
      ...needs
        .filter((t) => !snoozed(t))
        .map((t) => ({
          ...member(t),
          lane: inEmergencyLane({
            category: t.category,
            extracted: { urgency: t.urgency, injection: t.injection === "true" },
          }),
          waitingSince: asDate(t.waitingSince),
        })),
      ...checkIns
        .filter((t) => !snoozed(t))
        // A check-in is never an emergency (no "tonight only" snooze, not first in the email).
        .map((t) => ({ ...member(t), emergency: false, checkIn: true, waitingSince: null })),
    ]),
    drafts: backFirst(
      pending
        .filter((r) => !snoozed(r))
        .map((r) => ({ ...member(r), draftId: r.draftId, kind: r.kind })),
    ),
  };
}

export type QueueTotals = { needsYou: number; replies: number; nudges: number; drafts: number };

/** The queue's numbers, from the same membership as the screen (plan M8 A1): counts only. */
export async function queueCounts(
  workspaceId: string,
  now: Date = new Date(),
): Promise<QueueTotals> {
  return countQueue(await queueMembership(workspaceId, now));
}

/**
 * Only what the owner can act on: members on a plan-paused Gmail address are left out
 * (integration 2026-10-17). The queue screen still shows them, marked paused; every count —
 * the morning email, the badge, the phone's notification, the banner — uses this.
 */
export function actionableQueue(q: QueueMembership): QueueMembership {
  return {
    needsYou: q.needsYou.filter((m) => !m.paused),
    drafts: q.drafts.filter((m) => !m.paused),
  };
}

/** The totals of a membership already loaded (plan-paused addresses left out). */
export function countQueue(all: QueueMembership): QueueTotals {
  const q = actionableQueue(all);
  const replies = q.drafts.filter((d) => d.kind === "reply").length;
  return {
    needsYou: q.needsYou.length,
    replies,
    nudges: q.drafts.length - replies,
    drafts: q.drafts.length,
  };
}

/** How many "Needs you" cards the queue screen shows at once (the counts above have no cap). */
const NEEDS_YOU_SHOWN = 50;

/**
 * The needs-you members the queue screen renders as cards: the newest 50, plus whatever the
 * morning summary links to (its top picks are the oldest and most urgent, which are exactly
 * the ones past 50), so every `#t-<id>` it sends lands.
 */
function shownNeedsYou(members: QueueMembership) {
  const linked = headerPickIds(members.needsYou.map(toNeedsYouItem));
  return members.needsYou.filter((m, i) => i < NEEDS_YOU_SHOWN || linked.has(m.threadId));
}

/**
 * The thread ids that have a card on the queue screen (`id="t-<uuid>"`), from the same rules
 * listQueue renders with — so a notification only deep-links to a card that's there (A26).
 */
export function queueCardIds(members: QueueMembership): Set<string> {
  return new Set([
    ...shownNeedsYou(members).map((m) => m.threadId),
    ...members.drafts.map((m) => m.threadId),
  ]);
}

/** The queue: threads that need the owner with no draft first, then drafts waiting for a decision. */
export async function listQueue(
  workspaceId: string,
  now: Date = new Date(),
): Promise<{ needsYou: QueueItem[]; drafts: QueueItem[] }> {
  // Membership (and order) come from the content-free rules, so the screen and every count
  // agree by construction; this only adds what the owner reads on the cards.
  const members = await queueMembership(workspaceId, now);
  const shownNeeds = shownNeedsYou(members);
  if (shownNeeds.length === 0 && members.drafts.length === 0) return { needsYou: [], drafts: [] };

  const boxes = await db()
    .select({ id: mailboxes.id, email: mailboxes.email, planPausedAt: mailboxes.planPausedAt })
    .from(mailboxes)
    .where(eq(mailboxes.workspaceId, workspaceId));
  const boxIds = boxes.map((b) => b.id);
  const emailOf = new Map(boxes.map((b) => [b.id, b.email]));
  const pausedBoxes = new Set(boxes.filter((b) => b.planPausedAt).map((b) => b.id));

  const needIds = shownNeeds.map((m) => m.threadId);
  const draftIds = members.drafts.map((m) => m.draftId);
  const [needRows, draftRows] = await Promise.all([
    needIds.length
      ? db()
          .select()
          .from(threads)
          .where(and(inArray(threads.id, needIds), inArray(threads.mailboxId, boxIds)))
      : Promise.resolve([]),
    draftIds.length
      ? db()
          .select({ draft: drafts, thread: threads })
          .from(drafts)
          .innerJoin(threads, eq(threads.id, drafts.threadId))
          .where(and(inArray(drafts.id, draftIds), inArray(drafts.mailboxId, boxIds)))
      : Promise.resolve([]),
  ]);
  const threadById = new Map(needRows.map((t) => [t.id, t]));
  const draftById = new Map(draftRows.map((r) => [r.draft.id, r]));

  // The customer as a reply addresses them: a website form's Reply-To, else the sender.
  type Who = {
    name: string | null;
    address: string | null;
    redirected: boolean;
    sentAt: Date | null;
  };
  const senders = async (threadIds: string[]) => {
    if (!threadIds.length) return new Map<string, Who>();
    const rows = await db()
      .select({
        threadId: messages.threadId,
        name: messageReplyName(),
        address: messageReplyAddress(),
        redirected: sql<boolean>`(${messages.replyToHeader}->>'address' is not null)`,
        sentAt: messages.sentAt,
      })
      .from(messages)
      .where(and(inArray(messages.threadId, threadIds), eq(messages.direction, "in")))
      .orderBy(desc(messages.sentAt));
    const out = new Map<string, Who>();
    for (const r of rows)
      if (!out.has(r.threadId))
        out.set(r.threadId, {
          name: r.name,
          address: r.address,
          redirected: !!r.redirected,
          sentAt: r.sentAt,
        });
    return out;
  };
  const who = await senders([...needIds, ...members.drafts.map((m) => m.threadId)]);

  return {
    needsYou: shownNeeds.flatMap((m) => {
      const t = threadById.get(m.threadId);
      if (!t) return [];
      return [
        {
          draftId: null,
          draftCreatedAt: null,
          kind: null,
          purpose: null,
          autoSendAt: null,
          threadId: t.id,
          customerName: who.get(t.id)?.name ?? null,
          customerAddress: who.get(t.id)?.address ?? null,
          toAddress: null,
          replyRedirected: who.get(t.id)?.redirected ?? false,
          category: t.category,
          summary: t.summary,
          needsOwnerReason: t.needsOwnerReason,
          reason: null,
          body: null,
          flags: [],
          confidence: null,
          usedFacts: [],
          opening: null,
          revisionsLeft: 0,
          emergency: m.emergency,
          backFromSnooze: m.backFromSnooze,
          gmailThreadId: t.gmailThreadId,
          mailboxEmail: emailOf.get(t.mailboxId) ?? "",
          lastMessageAt: t.lastMessageAt,
          customerWroteAt: who.get(t.id)?.sentAt ?? null,
          leadChannel: t.leadChannel,
          extracted: t.extracted,
          lane: m.lane,
          checkIn: m.checkIn,
          complaintFixedAt: t.complaintFixedAt,
          mailboxPaused: pausedBoxes.has(t.mailboxId),
        } satisfies QueueItem,
      ];
    }),
    drafts: members.drafts.flatMap((m) => {
      const r = draftById.get(m.draftId);
      if (!r) return [];
      const { draft, thread } = r;
      return [
        {
          draftId: draft.id,
          draftCreatedAt: draft.createdAt,
          kind: draft.kind,
          purpose: draft.purpose ?? null,
          autoSendAt: draft.autoSendAt,
          threadId: thread.id,
          customerName: who.get(thread.id)?.name ?? null,
          customerAddress: who.get(thread.id)?.address ?? draft.toAddress,
          toAddress: draft.toAddress,
          replyRedirected: who.get(thread.id)?.redirected ?? false,
          category: thread.category,
          summary: thread.summary,
          needsOwnerReason: thread.needsOwner ? thread.needsOwnerReason : null,
          reason: draft.reason,
          body: draft.body,
          flags: draft.flags,
          confidence: draft.confidence,
          usedFacts: draft.usedFacts,
          opening: draft.opening ?? null,
          revisionsLeft: Math.max(0, MAX_REVISIONS_PER_DRAFT - draft.revisions),
          emergency: m.emergency,
          backFromSnooze: m.backFromSnooze,
          gmailThreadId: thread.gmailThreadId,
          mailboxEmail: emailOf.get(draft.mailboxId) ?? "",
          lastMessageAt: thread.lastMessageAt,
          customerWroteAt: who.get(thread.id)?.sentAt ?? null,
          leadChannel: thread.leadChannel,
          extracted: thread.extracted,
          lane: false,
          checkIn: false,
          complaintFixedAt: thread.complaintFixedAt,
          mailboxPaused: pausedBoxes.has(draft.mailboxId),
        } satisfies QueueItem,
      ];
    }),
  };
}

/**
 * Threads that should get a reply drafted now: classified since the customer's
 * latest message, draftable category, not needing the owner, and no draft
 * written since that message.
 */
export async function threadsToAutoDraft(mailboxId: string, limit = 10): Promise<string[]> {
  const lastIn = sql`(select max(m.sent_at) from messages m where m.thread_id = ${threads.id} and m.direction = 'in')`;
  // Deliberately counts a Gmail draft older sync stored as owner mail (not notDraftSql): until
  // draft-message-cleanup has checked it with Gmail it might be the owner's answer, sent under
  // the same id, and an auto-draft could go out on autopilot. No reply drafted until checked;
  // the owner's own "Draft a reply" still works.
  const lastOut = sql`(select max(m.sent_at) from messages m where m.thread_id = ${threads.id} and m.direction = 'out')`;
  const lastDraft = sql`(select max(d.created_at) from drafts d where d.thread_id = ${threads.id})`;
  // A customer whose reply address is a no-reply one is skipped (`no_reply_address`) without a
  // draft, so it would stay a candidate until new mail came and could fill every slot ahead of
  // an older real lead. Leave those out here. An unchecked Reply-To (NULL) stays in: a form
  // sent from no-reply@ often carries the customer's own address there.
  const newestInNoReply = sql`exists (select 1 from (select nr_m.reply_to_header, nr_m.from_address from messages nr_m where nr_m.thread_id = ${threads.id} and nr_m.direction = 'in' order by nr_m.sent_at desc limit 1) nr where nr.reply_to_header is not null and ${noReplySql(replyAddressSql("nr"))})`;
  // A gas smell, CO alarm or electrical fire sign (round 2 TW B4, Check 22 P4, Check 37 P1)
  // still waiting for its fixed note.
  const safetyWaiting = and(
    sql`coalesce(${threads.extracted}->>'gas_smell' = 'true' or ${threads.extracted}->>'co_alarm' = 'true' or ${threads.extracted}->>'electrical_hazard' = 'true', false)`,
    sql`not exists (select 1 from drafts d where d.thread_id = ${threads.id} and d.purpose = 'safety')`,
  );
  const due = and(
    eq(threads.mailboxId, mailboxId),
    eq(threads.inInbox, true),
    // A safety note is written whatever the sort; createDraftForThread writes it once per
    // thread, then the thread waits for the owner.
    or(
      and(eq(threads.needsOwner, false), inArray(threads.category, [...AUTO_DRAFT_CATEGORIES])),
      and(
        safetyWaiting,
        // Never on junk unless the owner has written on the conversation (the note itself
        // re-checks the address, createDraftForThread).
        sql`(${threads.category} is distinct from 'noise' or exists (select 1 from messages o where o.thread_id = ${threads.id} and o.direction = 'out'))`,
      ),
    ),
    sql`${threads.classifiedAt} is not null and ${threads.classifiedAt} >= ${lastIn}`,
    sql`(${lastOut} is null or ${lastOut} < ${lastIn})`,
    sql`(${lastDraft} is null or ${lastDraft} < ${lastIn})`,
    // "I called them" after the newest email (round 2, FW E11): nothing to draft.
    sql`(${threads.handledOfflineAt} is null or ${threads.handledOfflineAt} < ${lastIn})`,
    sql`not ${newestInNoReply}`,
    // Ideas H3: the newest email was sorted under a "Never draft" rule.
    sql`(${threads.extracted}->>'sender_rule') is distinct from 'no_draft'`,
  );
  const pick = (where: ReturnType<typeof and>) =>
    db()
      .select({ id: threads.id })
      .from(threads)
      .where(where)
      .orderBy(desc(threads.lastMessageAt))
      .limit(limit);
  // Check 39 P1: safety notes first. They need no model, so they are written even when the
  // day's AI limit stops the draft loop at the first reply that needs one.
  const [first, rest] = [await pick(and(due, safetyWaiting)), await pick(due)];
  return [...new Set([...first, ...rest].map((r) => r.id))].slice(0, limit);
}

/** For the "squared away." moment: a draft this workspace just sent. */
/** Check 9 P10: the send-path rows of Activity that say what last happened to a tap. */
const SEND_STEPS = ["send_approved", "send_undone", "send_stopped", "send_stood_down"] as const;

/** Check 9 P10: a send is "late" once its window ended this long ago and nobody holds it. */
export const LATE_SEND_MS = 60_000;

const lateWhere = (now: Date) =>
  and(
    eq(drafts.status, "pending"),
    isNotNull(drafts.sendAfter),
    lte(drafts.sendAfter, new Date(now.getTime() - LATE_SEND_MS)),
    or(
      isNull(drafts.sendClaimedAt),
      lt(drafts.sendClaimedAt, new Date(now.getTime() - SEND_CLAIM_LEASE_MS)),
    ),
  );

export async function sentDraftSummary(
  workspaceId: string,
  draftId: string,
  now: Date = new Date(),
) {
  const row = await loadOwnedDraft(workspaceId, draftId);
  if (!row) return null;
  const pending = row.draft.status === "pending";
  const sendingAt = pending ? row.draft.sendAfter : null;
  if (!sendingAt && row.draft.status !== "sent" && row.draft.status !== "edited_and_sent") {
    // Check 9 P10: a tap that didn't end in a send says why, instead of vanishing — the send
    // was stopped after the undo window (back in the queue) or stood down (set aside).
    if (!pending && row.draft.status !== "expired") return null;
    const [last] = await db()
      .select({ action: activityLog.action, detail: activityLog.detail })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.workspaceId, workspaceId),
          inArray(activityLog.action, [...SEND_STEPS]),
          sql`${activityLog.detail}->>'draftId' = ${draftId}`,
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(1);
    const why =
      pending && last?.action === "send_stopped"
        ? String(last.detail.why ?? "unknown")
        : !pending && last?.action === "send_stood_down"
          ? String(last.detail.reason ?? "answered_elsewhere")
          : null;
    if (!why) return null;
    return {
      draftId: row.draft.id,
      sendingAt: null,
      stopped: { why },
      late: false,
      toName: (await customerOf(row.thread.id))?.name ?? null,
      toAddress: row.draft.toAddress,
      category: row.thread.category,
      kind: row.draft.kind,
      purpose: row.draft.purpose ?? null,
      nudgeOn: null,
      waitingUntil: null,
      lastNudgeUsed: false,
    };
  }
  const to = await customerOf(row.thread.id);
  const settings = await followupSettings(workspaceId);
  const chased =
    settings.enabled &&
    // A deposit, review request or closing question is never followed by a nudge (A3).
    row.draft.purpose == null &&
    // Check 12 P1: the same "needs you" rule as the scan.
    !needsOwnerBlocksNudge(row.thread) &&
    !quoteStopsNudges(row.thread) &&
    row.thread.invoicePaidAt == null &&
    FOLLOWUP_CATEGORIES.includes(row.thread.category as (typeof FOLLOWUP_CATEGORIES)[number]) &&
    !(await nudgeBlocked(row.thread));
  const sentNudges = chased ? await countSentFollowups(row.thread.id) : 0;
  const decidedAt = row.draft.decidedAt ?? sendingAt ?? new Date();
  return {
    draftId: row.draft.id,
    /** Plan #7: still in its undo window until then. Null once sent. */
    sendingAt,
    /** Check 9 P10: set when the tap didn't end in a send (why: a send_stopped reason). */
    stopped: null as { why: string } | null,
    /**
     * Check 9 P10: the window ended over a minute ago and no send job holds it (a lost event):
     * "Still sending. This is taking longer than usual." with Stop it.
     */
    late:
      sendingAt != null &&
      sendingAt.getTime() <= now.getTime() - LATE_SEND_MS &&
      (row.draft.sendClaimedAt == null ||
        row.draft.sendClaimedAt.getTime() < now.getTime() - SEND_CLAIM_LEASE_MS),
    toName: to?.name ?? null,
    toAddress: row.draft.toAddress,
    category: row.thread.category,
    kind: row.draft.kind,
    purpose: row.draft.purpose ?? null,
    /** When we'll nudge if they go quiet; null if we won't. */
    nudgeOn:
      chased && sentNudges < MAX_FOLLOWUPS
        ? new Date(decidedAt.getTime() + settings.days * 86_400_000)
        : null,
    /**
     * Check 21 P2: they asked us to wait; the sent screen says "Waiting until Jan 4, as they
     * asked." instead of the next nudge day.
     */
    waitingUntil:
      chased &&
      sentNudges < MAX_FOLLOWUPS &&
      row.thread.nudgeAfter &&
      row.thread.nudgeAfter.getTime() > now.getTime()
        ? row.thread.nudgeAfter
        : null,
    lastNudgeUsed: chased && sentNudges >= MAX_FOLLOWUPS,
  };
}

/**
 * Check 9 P10: sends whose undo window ended over a minute ago and that no job holds (the
 * queue event was lost; the 15-minute backstop will send them). They're hidden from the queue
 * meanwhile, so the Queue lists them on top: "Waiting to send: reply to Priya", with Stop it.
 */
export async function lateSends(workspaceId: string, now: Date = new Date()) {
  const rows = await db()
    .select({ draftId: drafts.id, threadId: drafts.threadId, toAddress: drafts.toAddress })
    .from(drafts)
    .innerJoin(mailboxes, eq(mailboxes.id, drafts.mailboxId))
    .where(and(eq(mailboxes.workspaceId, workspaceId), lateWhere(now)))
    .orderBy(asc(drafts.sendAfter))
    .limit(10);
  return Promise.all(
    rows.map(async (r) => {
      const who = await customerOf(r.threadId);
      return { draftId: r.draftId, to: who?.name || who?.address || r.toAddress };
    }),
  );
}
