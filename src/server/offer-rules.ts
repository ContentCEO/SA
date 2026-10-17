/**
 * Owner-tap offers (plan #29 review request, #26 closing question). Pure rules: the screens
 * show an offer only when these allow it, and `createDraftForThread` re-checks the same
 * rules before any model call, whatever the screen showed. Nothing here ever drafts or sends
 * by itself.
 */
import { isReceiptSender } from "./money-rules";
import { isNoReplyAddress } from "./sender-rules";

// The no-reply rule is shared with response time and leads at risk (plan M8 A13).
export { isNoReplyAddress } from "./sender-rules";

/** One review request per customer address in this many days (pending or sent counts). */
export const REVIEW_REQUEST_WINDOW_DAYS = 365;
/** A complaint from this customer in this many days rules out a review request (A1). */
export const COMPLAINT_MEMORY_DAYS = 365;
/** Quiet days after the owner's last message before the closing question is offered. */
export const CLOSING_QUIET_DAYS = 7;
/** Sent follow-ups a thread must have used up before the closing question. */
export const CLOSING_AFTER_NUDGES = 2;

const DAY_MS = 86_400_000;

/** A payment receipt or an automated sender: never asked for a review (A2). */
export function isAutomatedSender(address: string | null | undefined): boolean {
  const s = (address ?? "").trim().toLowerCase();
  if (s.lastIndexOf("@") <= 0) return false;
  // A machine (no-reply, notifications…) is never a person who could leave a review (A2).
  return isNoReplyAddress(s) || isReceiptSender(s);
}

export type ReviewOfferReason = "complaint" | "not_eligible" | "no_review_link" | "review_recent";

export type ReviewFacts = {
  category: string | null;
  needsOwner: boolean;
  needsOwnerManual: boolean;
  /** This thread, or this customer anywhere in the last 12 months, complained (A1). */
  complained: boolean;
  /** The email tried to instruct the assistant, or came from a building department. */
  untrusted: boolean;
  /** The customer said the job is done (extracted.job_done). */
  jobDone: boolean;
  /** The invoice is marked paid (by the owner or our guess) — never "Not owed to me". */
  invoicePaid: boolean;
  /**
   * Who the request would go to: the newest inbound email's reply address (a website form's
   * Reply-To, else its sender), lowercased.
   */
  customerAddress: string | null;
  /**
   * Who sent that email (From), when it differs: a receipt sender (Stripe, QuickBooks) puts
   * the merchant in Reply-To, and is still a receipt.
   */
  senderAddress?: string | null;
  /** The owner has written to that address before (A2). */
  ownerWroteToThem: boolean;
  reviewUrl: string | null;
  /** A review request to that address, pending or sent, in the last 12 months. */
  recentReviewToAddress: boolean;
};

/**
 * Why the owner can't ask this customer for a review, or null when they can. Order matters:
 * a complaint always says so (it is the reason the owner most needs to see), then threads
 * that need the owner, then anyone who isn't a real, known customer with a finished job,
 * then a missing link, then the 12-month limit.
 */
export function reviewOfferReason(f: ReviewFacts): ReviewOfferReason | null {
  if (f.category === "complaint" || f.complained) return "complaint";
  if (f.needsOwner || f.needsOwnerManual) return "not_eligible";
  if (f.untrusted) return "not_eligible";
  if (f.category === "noise" || f.category === "supplier_vendor") return "not_eligible";
  if (!f.customerAddress || isAutomatedSender(f.customerAddress)) return "not_eligible";
  if (f.senderAddress && isReceiptSender(f.senderAddress)) return "not_eligible";
  if (!f.ownerWroteToThem) return "not_eligible";
  if (!(f.jobDone || f.invoicePaid)) return "not_eligible";
  if (!f.reviewUrl) return "no_review_link";
  if (f.recentReviewToAddress) return "review_recent";
  return null;
}

/**
 * "Say thanks" on a paid invoice (Davi, 2026-10-16). Why the owner can't thank this customer
 * from Money, or null when they can. Looser than a review request on purpose: a big invoice
 * that needed the owner, or a customer who once complained, still gets a plain thank-you — only
 * the review ask inside it follows every review rule (`reviewOfferReason`). Never a robot, a
 * receipt, a supplier, junk, or an email that tried to instruct the assistant or came from a
 * building department; once per thread.
 */
export type ThankYouOfferReason = "not_eligible" | "already_asked";

export type ThankYouFacts = Pick<
  ReviewFacts,
  "category" | "untrusted" | "invoicePaid" | "customerAddress" | "senderAddress"
> & {
  /** A thank-you was already written on this thread (waiting, sent or discarded). */
  thankedBefore: boolean;
};

export function thankYouOfferReason(f: ThankYouFacts): ThankYouOfferReason | null {
  if (f.thankedBefore) return "already_asked";
  if (!f.invoicePaid) return "not_eligible";
  if (f.untrusted) return "not_eligible";
  if (f.category === "noise" || f.category === "supplier_vendor") return "not_eligible";
  if (!f.customerAddress || isAutomatedSender(f.customerAddress)) return "not_eligible";
  if (f.senderAddress && isReceiptSender(f.senderAddress)) return "not_eligible";
  return null;
}

export type ClosingQuestionReason = "feature_off" | "complaint" | "not_eligible" | "already_asked";

export type ClosingFacts = {
  featureOn: boolean;
  isQuoteThread: boolean;
  category: string | null;
  needsOwner: boolean;
  /** This thread ever held a complaint (A1). */
  complained: boolean;
  /** The quote's outcome, whoever set it. Won or lost rules it out; no answer doesn't. */
  outcome: string | null;
  /** Follow-up nudges actually sent on the thread. */
  sentNudges: number;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  /** A closing question was ever drafted on this thread, in any state (once ever). */
  askedBefore: boolean;
};

/**
 * Why the owner can't ask "did you go another way?", or null when they can (plan #26): a
 * quote, both nudges used, the owner wrote last, a week of quiet since, and never asked.
 */
export function closingQuestionReason(f: ClosingFacts, now: Date): ClosingQuestionReason | null {
  if (!f.featureOn) return "feature_off";
  if (f.category === "complaint" || f.complained) return "complaint";
  if (f.askedBefore) return "already_asked";
  if (!f.isQuoteThread || f.needsOwner) return "not_eligible";
  if (f.outcome === "won" || f.outcome === "lost") return "not_eligible";
  if (f.sentNudges < CLOSING_AFTER_NUDGES) return "not_eligible";
  if (!f.lastOutboundAt) return "not_eligible";
  if (f.lastInboundAt && f.lastInboundAt >= f.lastOutboundAt) return "not_eligible";
  if (now.getTime() - f.lastOutboundAt.getTime() < CLOSING_QUIET_DAYS * DAY_MS) {
    return "not_eligible";
  }
  return null;
}
