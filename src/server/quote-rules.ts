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
  f: {
    lastInboundAt: Date | null;
    lastOutboundAt: Date | null;
    sentNudges: number;
    /** Check 21 P2: count quiet days from here instead (the date they asked us to wait for). */
    quietFrom?: Date;
  },
  now: Date,
): "two_nudges" | "three_weeks" | null {
  if (!f.lastInboundAt || !f.lastOutboundAt || f.lastOutboundAt <= f.lastInboundAt) return null;
  const from = f.quietFrom && f.quietFrom > f.lastOutboundAt ? f.quietFrom : f.lastOutboundAt;
  const quietDays = (now.getTime() - from.getTime()) / 86_400_000;
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
/** Check 21 P2: the note on a waiting nudge when the customer said no. */
export const DECLINED_FLAG = "They said no. Check before sending.";

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

/**
 * Ideas C5: why a quote was lost, in one optional tap. ("No answer" is its own outcome.) "Other"
 * added 2026-10-16 (Davi: yes). The column is plain text (no check constraint): older code reads
 * "other" as no reason and simply doesn't show it.
 */
export const LOST_REASONS = ["price", "timing", "someone_else", "other"] as const;
export type LostReason = (typeof LOST_REASONS)[number];
export const isLostReason = (v: unknown): v is LostReason =>
  typeof v === "string" && (LOST_REASONS as readonly string[]).includes(v);

/** The buttons' words. */
export const LOST_REASON_BUTTONS: Record<LostReason, string> = {
  price: "Price",
  timing: "Timing",
  someone_else: "Went with someone else",
  other: "Other",
};
/** "Lost: price" on a card. */
export const LOST_REASON_WORDS: Record<LostReason, string> = {
  price: "price",
  timing: "timing",
  someone_else: "went with someone else",
  other: "another reason",
};

/** The reason, only while the quote is lost: a stale value left on a reopened quote never shows. */
export function shownLostReason(outcome: string | null, reason: unknown): LostReason | null {
  return outcome === "lost" && isLostReason(reason) ? reason : null;
}

/**
 * "Lost this month: 4 on price, 1 on timing, 2 went with someone else, 1 for another reason." —
 * and when one named reason is at least half of them and 3 or more: "You lost 4 on price this
 * month." "Other" is never the headline (it says nothing the owner can act on). Null with none set.
 */
export function lostReasonsSentence(counts: Partial<Record<LostReason, number>>): string | null {
  const n = (r: LostReason) => Math.max(0, Math.round(counts[r] ?? 0));
  const parts = [
    n("price") ? `${n("price")} on price` : null,
    n("timing") ? `${n("timing")} on timing` : null,
    n("someone_else") ? `${n("someone_else")} went with someone else` : null,
    n("other")
      ? `${n("other")} for ${n("other") === 1 ? "another reason" : "other reasons"}`
      : null,
  ].filter((p): p is string => !!p);
  if (!parts.length) return null;
  const total = LOST_REASONS.reduce((sum, r) => sum + n(r), 0);
  const top = LOST_REASONS.filter((r) => r !== "other").sort((a, b) => n(b) - n(a))[0]!;
  const lead = `Lost this month: ${parts.join(", ")}.`;
  if (n(top) >= 3 && n(top) * 2 >= total)
    return `${lead} ${
      top === "someone_else"
        ? `${n(top)} went with someone else this month.`
        : `You lost ${n(top)} on ${top} this month.`
    }`;
  return lead;
}

/** Ideas K2: which lead sources pay — the window, the row cap, and when the card shows. */
export const LEAD_PAY_DAYS = 90;
export const LEAD_PAY_MAX_ROWS = 6;
export const WEBSITE_FORM = "Website form";
export const EVERYWHERE_ELSE = "Everywhere else";

export type LeadPayInput = {
  label: string;
  /** Answered off email (a lead site): we can't see those replies, so only the owner's Won counts. */
  offEmail: boolean;
  outcome: string | null;
  outcomeSource: string | null;
  amountCents: number | null;
};
export type LeadPayRow = {
  label: string;
  offEmail: boolean;
  requests: number;
  won: number;
  wonCents: number;
};

/**
 * One row per source: requests, won and won dollars. For an off-email source a won counts only
 * when the owner marked it (our guesses come from email we can't see there). Sorted by won
 * dollars, then won, then requests; past 6 rows the rest fold into "Everywhere else". Null
 * when fewer than two sources have requests (nothing to compare).
 */
export function leadPayRows(rows: readonly LeadPayInput[]): LeadPayRow[] | null {
  const by = new Map<string, LeadPayRow>();
  for (const r of rows) {
    const row = by.get(r.label) ?? {
      label: r.label,
      offEmail: r.offEmail,
      requests: 0,
      won: 0,
      wonCents: 0,
    };
    row.requests += 1;
    const won = r.outcome === "won" && (!r.offEmail || (r.outcomeSource ?? "owner") === "owner");
    if (won) {
      row.won += 1;
      row.wonCents += r.amountCents ?? 0;
    }
    by.set(r.label, row);
  }
  if (by.size < 2) return null;
  const sorted = [...by.values()].sort(
    (a, b) => b.wonCents - a.wonCents || b.won - a.won || b.requests - a.requests,
  );
  if (sorted.length <= LEAD_PAY_MAX_ROWS) return sorted;
  const kept = sorted.slice(0, LEAD_PAY_MAX_ROWS - 1);
  const rest = sorted.slice(LEAD_PAY_MAX_ROWS - 1).reduce<LeadPayRow>(
    (t, r) => ({
      ...t,
      offEmail: t.offEmail || r.offEmail,
      requests: t.requests + r.requests,
      won: t.won + r.won,
      wonCents: t.wonCents + r.wonCents,
    }),
    { label: EVERYWHERE_ELSE, offEmail: false, requests: 0, won: 0, wonCents: 0 },
  );
  return [...kept, rest];
}

/**
 * "Direct email: 9 requests, 3 won, $6,200." / "Thumbtack: 6 requests, 2 you marked won,
 * $3,100." / "Thumbtack: 6 requests. Tap Won on Quotes to count jobs you won here." Never
 * "0 won" for a lead site.
 */
export function leadPaySentence(r: LeadPayRow): string {
  const req = `${r.requests} request${r.requests === 1 ? "" : "s"}`;
  const money = r.wonCents > 0 ? `, ${formatCents(r.wonCents)}` : "";
  if (r.offEmail) {
    if (r.won === 0) return `${r.label}: ${req}. Tap Won on Quotes to count jobs you won here.`;
    return `${r.label}: ${req}, ${r.won} you marked won${money}.`;
  }
  return `${r.label}: ${req}, ${r.won} won${money}.`;
}
