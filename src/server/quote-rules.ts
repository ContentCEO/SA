/**
 * Quote tracker rules. Pure functions; the tracker is built from mail we've
 * already sorted, plus the owner's one-tap Won / Lost.
 */

export const QUOTE_STAGES = ["waiting_on_you", "talking", "quiet", "won", "lost"] as const;
export type QuoteStage = (typeof QUOTE_STAGES)[number];

export const stageLabel: Record<QuoteStage, string> = {
  waiting_on_you: "Waiting on you",
  talking: "Quoted",
  quiet: "Gone quiet",
  won: "Won",
  lost: "Lost",
};

export type QuoteFacts = {
  outcome: string | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
};

/**
 * Where a quote stands:
 *  - the owner's Won / Lost always wins;
 *  - the customer wrote last (or the owner never replied) → waiting on you;
 *  - the owner wrote last, more than `quietDays` ago → gone quiet;
 *  - otherwise → quoted / talking.
 */
export function quoteStage(q: QuoteFacts, now: Date, quietDays: number): QuoteStage {
  if (q.outcome === "won" || q.outcome === "lost") return q.outcome;
  if (!q.lastOutboundAt || (q.lastInboundAt && q.lastInboundAt > q.lastOutboundAt)) {
    return "waiting_on_you";
  }
  const quietMs = quietDays * 24 * 60 * 60 * 1000;
  return now.getTime() - q.lastOutboundAt.getTime() >= quietMs ? "quiet" : "talking";
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
