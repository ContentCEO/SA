/**
 * Customers screen wording, as pure rules (Check 13 P5 / P6). Content-free: counts, amounts,
 * stages and times only.
 */
import { formatCents, quoteStage, type QuoteStage } from "./quote-rules";

/** Check 13 P5: a conversation card's stage line, in the words the Quotes screen uses. */
const CARD_STAGE: Record<QuoteStage, string> = {
  waiting_on_you: "Waiting on you",
  talking: "Priced, waiting on them",
  quiet: "Gone quiet",
  won: "Won",
  lost: "Lost",
  no_answer: "No answer",
};

/**
 * Check 13 P5: the stage line for one conversation on a customer's page. A quote thread gets
 * its Quotes stage ("Won $2,100" with an amount); any other thread says "Waiting on you" only
 * when the customer wrote last. Null = no line.
 */
export function customerThreadStage(
  t: {
    isQuote: boolean;
    outcome: string | null;
    amountCents: number | null;
    lastInboundAt: Date | null;
    lastOutboundAt: Date | null;
  },
  now: Date,
  quietDays: number,
): string | null {
  if (t.isQuote) {
    const stage = quoteStage(t, now, quietDays);
    if (stage === "won" && t.amountCents) return `Won ${formatCents(t.amountCents)}`;
    return CARD_STAGE[stage];
  }
  if (t.lastInboundAt && (!t.lastOutboundAt || t.lastInboundAt > t.lastOutboundAt))
    return "Waiting on you";
  return null;
}

/**
 * Check 13 P5: the facts line under a customer's name — "1 open quote · Won $2,100 · Owes $350
 * · Wrote you Oct 8". Empty parts are left out.
 */
export function customerFactsLine(
  f: {
    openQuotes: number;
    wonCents: number;
    owedCents?: number;
    lastWroteAt?: Date | null;
  },
  timeZone = "America/New_York",
): string {
  return [
    f.openQuotes ? `${f.openQuotes} open quote${f.openQuotes === 1 ? "" : "s"}` : null,
    f.wonCents ? `Won ${formatCents(f.wonCents)}` : null,
    f.owedCents ? `Owes ${formatCents(f.owedCents)}` : null,
    f.lastWroteAt
      ? `Wrote you ${f.lastWroteAt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone })}`
      : null,
  ]
    .filter((p): p is string => !!p)
    .join(" · ");
}
