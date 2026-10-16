/**
 * Quote tracker rules. Pure functions; the tracker is built from mail we've
 * already sorted, plus the owner's one-tap Won / Lost / No answer and our
 * guesses (plan #30), which the owner can always change.
 */

/** How a quote ended. Set by the owner, or guessed by us (`quote_outcome_source = 'auto'`). */
export const QUOTE_OUTCOMES = ["won", "lost", "no_answer"] as const;
export type QuoteOutcome = (typeof QUOTE_OUTCOMES)[number];
export const isQuoteOutcome = (v: unknown): v is QuoteOutcome =>
  typeof v === "string" && (QUOTE_OUTCOMES as readonly string[]).includes(v);

export const QUOTE_STAGES = [
  "waiting_on_you",
  "talking",
  "quiet",
  "won",
  "lost",
  "no_answer",
] as const;
export type QuoteStage = (typeof QUOTE_STAGES)[number];

export const stageLabel: Record<QuoteStage, string> = {
  waiting_on_you: "Waiting on you",
  talking: "Quoted",
  quiet: "Gone quiet",
  won: "Won",
  lost: "Lost",
  no_answer: "No answer",
};

/** Decided = has an outcome (won / lost / no answer). Everything else is still open. */
export function isDecidedStage(stage: QuoteStage): stage is QuoteOutcome {
  return isQuoteOutcome(stage);
}

export type QuoteFacts = {
  outcome: string | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
};

/**
 * Where a quote stands:
 *  - an outcome (won / lost / no answer — the owner's, or our guess) wins;
 *  - the customer wrote last (or the owner never replied) → waiting on you;
 *  - the owner wrote last, more than `quietDays` ago → gone quiet;
 *  - otherwise → quoted / talking.
 */
export function quoteStage(q: QuoteFacts, now: Date, quietDays: number): QuoteStage {
  if (isQuoteOutcome(q.outcome)) return q.outcome;
  if (!q.lastOutboundAt || (q.lastInboundAt && q.lastInboundAt > q.lastOutboundAt)) {
    return "waiting_on_you";
  }
  const quietMs = quietDays * 24 * 60 * 60 * 1000;
  return now.getTime() - q.lastOutboundAt.getTime() >= quietMs ? "quiet" : "talking";
}

/**
 * A quote thread: sorted as a quote request, or it has ever had an outcome (the owner's
 * or our guess — even one since cleared). A customer's later email is often sorted as
 * scheduling or a question, which overwrites the category; once a thread has been a
 * decided quote it stays on Quotes, and can still be guessed / marked won. SQL twin:
 * `quoteThreadSql` in quotes.ts.
 */
export function isQuoteThread(t: {
  category: string | null;
  quoteOutcome: string | null;
  quoteOutcomeSource: string | null;
}): boolean {
  return t.category === "quote_request" || t.quoteOutcome != null || t.quoteOutcomeSource != null;
}

/**
 * Whether a thread's quote outcome stops follow-up nudges on it (plan #30, A3). Lost or
 * no answer (the owner's or our guess) stop every nudge. Won stops the quote nudges, but
 * a won job's thread often carries on as its invoice, and that is still chased (a paid
 * invoice stops those). SQL twin in followups.ts (`threadsToFollowUp`).
 */
export function quoteStopsNudges(t: {
  quoteOutcome: string | null;
  category: string | null;
}): boolean {
  if (t.quoteOutcome == null) return false;
  return !(t.quoteOutcome === "won" && t.category === "invoice_payment");
}

/** Two nudges sent, then this many quiet days → we guess "no answer". */
export const NO_ANSWER_AFTER_NUDGES_DAYS = 7;
/**
 * With fewer than two nudges sent (follow-ups off, or the owner discarded them),
 * this many quiet days since the owner last wrote → we guess "no answer".
 */
export const NO_ANSWER_WITHOUT_NUDGES_DAYS = 21;
const NUDGES_BEFORE_NO_ANSWER = 2;

/**
 * Our "no answer" guess for an open quote: the customer wrote at least once,
 * the owner wrote last, and it's been quiet since — a week after two nudges,
 * or three weeks however many were sent. Returns why, or null for no guess.
 */
export function guessNoAnswer(
  f: { lastInboundAt: Date | null; lastOutboundAt: Date | null; sentNudges: number },
  now: Date,
): "two_nudges" | "three_weeks" | null {
  if (!f.lastInboundAt || !f.lastOutboundAt || f.lastOutboundAt <= f.lastInboundAt) return null;
  const quietDays = (now.getTime() - f.lastOutboundAt.getTime()) / 86_400_000;
  if (f.sentNudges >= NUDGES_BEFORE_NO_ANSWER && quietDays >= NO_ANSWER_AFTER_NUDGES_DAYS)
    return "two_nudges";
  if (quietDays >= NO_ANSWER_WITHOUT_NUDGES_DAYS) return "three_weeks";
  return null;
}

/** The quiet-days bar `guessNoAnswer` uses for this many sent nudges. */
export function noAnswerAfterDays(sentNudges: number): number {
  return sentNudges >= NUDGES_BEFORE_NO_ANSWER
    ? NO_ANSWER_AFTER_NUDGES_DAYS
    : NO_ANSWER_WITHOUT_NUDGES_DAYS;
}

/**
 * Whether we may write our guess over a thread's outcome. The owner always wins:
 * never over anything the owner set (including a reopen: outcome null, source owner),
 * and never over an outcome with no source — it predates the column and is the owner's.
 * Used as an early skip (afterClassified, guessNoAnswers); the authoritative guard is
 * the same rule in the WHERE of `autoSetQuoteOutcome`, which the DB guardrail tests call
 * directly for every owner choice.
 */
export function canAutoSet(outcome: string | null, source: string | null): boolean {
  if (source === "owner") return false;
  if (outcome != null && source == null) return false;
  return true;
}

/** Added to a waiting nudge when we guess a quote's outcome (a guess never deletes it). */
export const QUOTE_GUESS_FLAG = "We think this quote is closed — check before sending.";

/** The note on a waiting nudge closed because the owner decided the quote. */
export function quoteDecidedNote(outcome: QuoteOutcome): string {
  return `You marked this quote ${outcome === "no_answer" ? "no answer" : outcome}.`;
}

/** Won out of every decided quote (won + lost + no answer), as a whole percent. Null if none. */
export function closeRate(c: { won: number; lost: number; noAnswer: number }): number | null {
  const decided = c.won + c.lost + c.noAnswer;
  return decided ? Math.round((c.won / decided) * 100) : null;
}

/**
 * Whether a newly classified email accepts a quote the owner really gave.
 * Decided at classification time from the thread as it was BEFORE this email,
 * because an acceptance ("Let's do it — can you start Monday?") is often
 * re-sorted as scheduling, which overwrites the thread's category. Needs:
 *  - the model's accepts_quote signal;
 *  - a quote context: the thread was a quote (by its previous category or
 *    outcome), or this email itself is sorted as a quote request;
 *  - the owner wrote on the thread before this email (no quote, no acceptance);
 *  - the owner gave a price before this email (`priceGiven`: the quote's amount is known,
 *    or an owner message has a dollar figure) — "I can come look Tuesday" → "Sounds good,
 *    book us in" is a site visit: no won guess, no deposit note;
 *  - the email didn't try to instruct the assistant.
 */
export function quoteAccepted(f: {
  acceptsQuote: boolean;
  injection: boolean;
  previous: {
    category: string | null;
    quoteOutcome: string | null;
    quoteOutcomeSource: string | null;
  };
  category: string;
  ownerWroteBefore: boolean;
  priceGiven: boolean;
}): boolean {
  return (
    f.acceptsQuote === true &&
    !f.injection &&
    (isQuoteThread(f.previous) || f.category === "quote_request") &&
    f.ownerWroteBefore &&
    f.priceGiven
  );
}

/**
 * Whether a thread's earlier quote acceptance carries over to its next classification
 * (which replaces `extracted` wholesale). Kept unless the owner has since decided the
 * quote any other way than won — marked lost / no answer, or reopened it.
 */
export function keepQuoteAccepted(t: {
  extracted: Record<string, unknown> | null;
  quoteOutcome: string | null;
  quoteOutcomeSource: string | null;
}): boolean {
  if (t.extracted?.quote_accepted !== true) return false;
  // An outcome with no source predates the column and is the owner's.
  const ownerDecided =
    t.quoteOutcomeSource === "owner" || (t.quoteOutcomeSource == null && t.quoteOutcome != null);
  return !(ownerDecided && t.quoteOutcome !== "won");
}

/**
 * The amount the owner quoted: the largest dollar figure in their own words
 * (quoted text from the customer already stripped). Null if none.
 */
export function amountFromOwnerText(text: string | null | undefined): number | null {
  if (!text) return null;
  const amounts = [...text.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)\s*(k\b)?/gi)]
    .map((m) => Number(m[1]!.replace(/,/g, "")) * (m[2] ? 1000 : 1))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 10_000_000);
  if (!amounts.length) return null;
  return Math.round(Math.max(...amounts) * 100);
}

/** "$1,450" / "$1,450.50" from cents. */
export function formatCents(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Parse what the owner typed ("1450", "$1,450.50") into cents, or null. */
export function parseDollars(input: string | null | undefined): number | null {
  const cleaned = (input ?? "").replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return cents > 0 && cents < 1_000_000_000 ? cents : null;
}
