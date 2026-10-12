/**
 * Purpose drafts (plan #26 #28 #29): rules that sit around the model. Pure.
 *
 * A purpose draft is an ordinary reply (`drafts.kind = 'reply'`) with `drafts.purpose` set.
 * It is never sent by autopilot, never in a batch, never counts toward earning autopilot,
 * never bumps the follow-up count, and once sent it stops follow-up nudges on its thread.
 */
import { DEPOSIT_GAP } from "./prompts/purpose.v1";
import { findGaps } from "./gaps";

/** Shown first on a deposit draft when the owner hasn't written down how they take deposits. */
export const NO_PAYMENT_TERMS_FLAG =
  "No payment terms in your profile — add how you take deposits in Settings.";
/** Shown first on a review request whose text lost the owner's review link. */
export const REVIEW_LINK_MISSING_FLAG = "The review link is missing — add it before sending.";
/** Either flag above caps the draft's confidence at this (A6). */
export const PURPOSE_FLAG_CONFIDENCE_CAP = 0.3;

/**
 * A deposit draft with no payment terms always carries a deposit gap for the owner to fill,
 * even when the model left it out: its own paragraph before the sign-off (the last paragraph).
 * A body that already has a deposit gap is returned unchanged.
 */
export function ensureDepositGap(body: string): string {
  if (findGaps(body).some((g) => g.kind === "custom" && /deposit/i.test(g.label))) return body;
  const paragraphs = body
    .trim()
    .split(/\n\s*\n/)
    .filter((p) => p.trim());
  if (paragraphs.length <= 1) return [...paragraphs, DEPOSIT_GAP].join("\n\n");
  return [...paragraphs.slice(0, -1), DEPOSIT_GAP, paragraphs.at(-1)!].join("\n\n");
}

/**
 * Whether the newest email on a thread accepts a quote the owner really gave (A5): the
 * model's signal on THIS email, and `quote_accepted`, decided at classification from the
 * thread as it was before (an acceptance is often re-sorted as scheduling). The deposit
 * draft is written for exactly these.
 */
export function isQuoteAcceptance(thread: { extracted: unknown }): boolean {
  const x = (thread.extracted ?? {}) as { accepts_quote?: unknown; quote_accepted?: unknown };
  return x.accepts_quote === true && x.quote_accepted === true;
}
