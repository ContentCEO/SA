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
  // Check 11 P6: the owner answered without a price (a site visit, "I called them").
  "replied",
  "talking",
  "quiet",
  "won",
  "lost",
  "no_answer",
] as const;
export type QuoteStage = (typeof QUOTE_STAGES)[number];

export const stageLabel: Record<QuoteStage, string> = {
  waiting_on_you: "Waiting on you",
  replied: "Replied, no price yet",
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
  /**
   * Check 11 P6: the owner gave a price — the quote's amount is known, or an owner email (not a
   * purpose note, not a draft) has a dollar figure (`ownerQuotedCents`).
   */
  priced: boolean;
};

/**
 * Where a quote stands:
 *  - an outcome (won / lost / no answer — the owner's, or our guess) wins;
 *  - the customer wrote last (or the owner never replied) → waiting on you;
 *  - the owner wrote last without a price (a site visit, "I called them") → replied, no price
 *    yet — it never goes quiet (Check 11 P6);
 *  - the owner wrote last with a price, more than `quietDays` ago → gone quiet;
 *  - otherwise → quoted / talking.
 */
export function quoteStage(q: QuoteFacts, now: Date, quietDays: number): QuoteStage {
  if (isQuoteOutcome(q.outcome)) return q.outcome;
  if (!q.lastOutboundAt || (q.lastInboundAt && q.lastInboundAt > q.lastOutboundAt)) {
    return "waiting_on_you";
  }
  if (!q.priced) return "replied";
  const quietMs = quietDays * 24 * 60 * 60 * 1000;
  return now.getTime() - q.lastOutboundAt.getTime() >= quietMs ? "quiet" : "talking";
}

/**
 * A quote thread: sorted as a quote request, OR it carries the sticky `quoteRequestedAt` mark
 * from classification, OR it has ever had an outcome (the owner's or our guess — even one
 * since cleared). A customer's later email is often sorted as scheduling or a question, which
 * overwrites the category; the quote stays on Quotes from the first request until it's
 * decided (Check 11 P1). A thread now sorted as noise, or with `extracted.injection`, is left
 * out unless the owner marked it. SQL twin: `quoteThreadSql` in thread-sql.ts — keep the two
 * in step. Fields the caller doesn't have count as empty.
 */
export function isQuoteThread(t: {
  category: string | null;
  quoteOutcome: string | null;
  quoteOutcomeSource: string | null;
  quoteRequestedAt?: Date | string | null;
  extracted?: unknown;
}): boolean {
  const ownerMarked =
    t.quoteOutcomeSource === "owner" || (t.quoteOutcome != null && t.quoteOutcomeSource == null);
  if (ownerMarked) return true;
  const injection = (t.extracted as { injection?: unknown } | null | undefined)?.injection;
  if (t.category === "noise" || injection === true) return false;
  return (
    t.category === "quote_request" ||
    t.quoteRequestedAt != null ||
    t.quoteOutcome != null ||
    t.quoteOutcomeSource != null
  );
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
 * Our "no answer" guess for an open quote: the owner gave a price (Check 11 P6: a site visit
 * nobody answered isn't a lost quote), the customer wrote at least once, the owner wrote last,
 * and it's been quiet since — a week after two nudges, or three weeks however many were sent.
 * Returns why, or null for no guess.
 */
export function guessNoAnswer(
  f: {
    lastInboundAt: Date | null;
    lastOutboundAt: Date | null;
    sentNudges: number;
    priced: boolean;
  },
  now: Date,
): "two_nudges" | "three_weeks" | null {
  if (!f.priced) return null;
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
 * Check 11 P2: cut what isn't the owner's own words before reading amounts (`prepareBody` has
 * already dropped "> " lines and one-line "On … wrote:"): a signature after a "--" line, an
 * Outlook header block ("From:" with "Sent:" or "Date:" within the next four lines) and what
 * follows, Gmail's "On …" line wrapped so the next line ends with "wrote:", and "Sent from my
 * iPhone" and what follows. Amounts only: the classifier keeps `prepareBody` as it is.
 */
export function stripForAmounts(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const next = (lines[i + 1] ?? "").trim();
    if (
      line === "--" ||
      /^sent from my /i.test(line) ||
      (/^On\s.+/.test(line) && /wrote:\s*$/.test(next)) ||
      (/^\*?From:\*?\s+\S/i.test(line) &&
        lines.slice(i + 1, i + 5).some((l) => /^\*?(Sent|Date):\*?\s/i.test(l.trim())))
    ) {
      break;
    }
    out.push(lines[i]!);
  }
  return out.join("\n").trim();
}

/** Check 11 P2: words right after a figure that make it not the job's price. */
const NOT_PRICE_AFTER =
  /\b(per hour|per hr|an hour|an hr|hourly|per month|a month|deposit|trip charge|service call|guarantee|warranty|tax)\b|\/\s?(hr|hour|mo|month)\b/i;
/** Check 11 P2: words right before a figure that make it not the price (or not the owner's). */
const NOT_PRICE_BEFORE = /\b(normally|usually|was|not|save|saves|costs me|cost me|budget|over)\b/i;
/**
 * Check 39 P3: program figures near a price — rebates, loans, tax credits, monthly payments,
 * caps ("up to"). Read on both sides, so an "after rebate" / "out of pocket" figure is
 * dropped too: the saved number is the price before incentives.
 */
const PROGRAM_WORDS =
  /\b(rebates?|incentives?|tax credits?|credits?|loans?|financing|per ton|a ton|a month|per month|monthly|up to|mass save|heat loan|after rebate|out of pocket)\b|0\s?%|\/\s?mo\b/i;
/** Words that say "this is the price": Check 11 P2. */
const PRICE_MARKER = /\b(total|all[ -]in|comes to|come to|price is|for the job|in total)\b/i;
/** Two or more of these → the owner gave choices, not one price. */
const OPTION_WORD = /\b(option|choice)\b/i;
const AFTER_WINDOW = 24;
const BEFORE_WINDOW = 14;
const PROGRAM_WINDOW = 30;

export type OwnerAmount = {
  cents: number;
  /**
   * 'total' — a figure the owner marked as the price ("$4,250 total", "price is $2,100"), or
   * the only figure left; 'picked' — the last of several figures (a guess the card asks the
   * owner to check, kept out of price memory).
   */
  note: "total" | "picked";
};

/**
 * The amount the owner quoted, from their own words (Check 11 P2 + Check 39 P3), with how sure
 * we are. Quoted customer text, signatures and forwarded headers are cut first
 * (`stripForAmounts`). Each "$" figure needs digits right after "$" or "$ " with no inner
 * spaces and proper thousands commas ("$ 3 200" and "$1,2k" give no figure: the owner types
 * it). A figure is dropped when the words around it (same sentence, never past another
 * figure) say it isn't the job's price: an hourly or monthly rate, a deposit, a trip charge,
 * a guarantee, tax, "normally / was / not / save / costs me / budget / over", or a program
 * figure (rebate, loan, tax credit, "up to", per ton, 0%) — so the saved number is the price
 * before incentives. Of what's left, the last figure marked as the price wins ('total'),
 * else the only one ('total'), else the LAST one ('picked'), never the largest. Several
 * options ("Option A $650, Option B $3,900") give null. Null when nothing is left.
 */
export function readOwnerAmount(text: string | null | undefined): OwnerAmount | null {
  if (!text) return null;
  const body = stripForAmounts(text);
  const re = /\$ ?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?(\s?k\b)?/gi;
  const found = [...body.matchAll(re)].map((m) => ({
    m,
    start: m.index!,
    end: m.index! + m[0].length,
  }));
  type Cand = { cents: number; marked: boolean; option: boolean };
  const kept: Cand[] = [];
  found.forEach(({ m, start, end }, i) => {
    const rest = body.slice(end);
    // "$ 3 200", "$1,2k", "$12.345": not a figure we can read.
    if (/^(\s\d|,\d|\.\d)/.test(rest)) return;
    const value = (Number(m[1]!.replace(/,/g, "")) + Number(m[2] ?? 0)) * (m[3] ? 1000 : 1);
    if (!Number.isFinite(value) || value <= 0 || value >= 10_000_000) return;
    // The figure's own clause: stop at a line break, a sentence end or the next figure.
    const prevEnd = i > 0 ? found[i - 1]!.end : 0;
    const nextStart = i + 1 < found.length ? found[i + 1]!.start : body.length;
    let before = body.slice(prevEnd, start);
    before = before.split(/\n|[.!?;](?:\s|$)/).pop() ?? "";
    let after = body.slice(end, nextStart);
    after = after.split(/\n|[.!?;](?:\s|$)/)[0] ?? "";
    const near = (s: string, n: number, fromEnd: boolean) =>
      fromEnd ? s.slice(-n) : s.slice(0, n);
    if (NOT_PRICE_AFTER.test(near(after, AFTER_WINDOW, false))) return;
    if (NOT_PRICE_BEFORE.test(near(before, BEFORE_WINDOW, true))) return;
    if (
      PROGRAM_WORDS.test(near(before, PROGRAM_WINDOW, true)) ||
      PROGRAM_WORDS.test(near(after, PROGRAM_WINDOW, false))
    )
      return;
    kept.push({
      cents: Math.round(value * 100),
      marked:
        PRICE_MARKER.test(near(before, PROGRAM_WINDOW, true)) ||
        PRICE_MARKER.test(near(after, PROGRAM_WINDOW, false)),
      option: OPTION_WORD.test(near(before, PROGRAM_WINDOW, true)),
    });
  });
  if (!kept.length) return null;
  const marked = kept.filter((c) => c.marked);
  if (marked.length) return { cents: marked[marked.length - 1]!.cents, note: "total" };
  if (kept.filter((c) => c.option).length >= 2) return null;
  if (kept.length === 1) return { cents: kept[0]!.cents, note: "total" };
  return { cents: kept[kept.length - 1]!.cents, note: "picked" };
}

/** The amount alone (see `readOwnerAmount`). Null if none. */
export function amountFromOwnerText(text: string | null | undefined): number | null {
  return readOwnerAmount(text)?.cents ?? null;
}

/**
 * Check 11 P7: a decided card's stage with its day — "Won Oct 14", "Lost Oct 11", "No answer
 * Oct 9" — in the owner's time zone (Eastern if it's invalid). Just the stage without a date.
 */
export function decidedLabel(outcome: QuoteOutcome, at: Date | null, timeZone: string): string {
  const word = stageLabel[outcome];
  if (!at) return word;
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    tz = "America/New_York";
  }
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
  }).format(at);
  return `${word} ${day}`;
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
