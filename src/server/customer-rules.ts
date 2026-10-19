/**
 * Customers screen wording, as pure rules (Check 13 P5 / P6). Content-free: counts, amounts,
 * stages and times only.
 */
import { relativeTime } from "@/lib/relative-time";
import { formatCents, quoteStage, type QuoteStage } from "./quote-rules";

/** Check 13 P5: a conversation card's stage line, in the words the Quotes screen uses. */
const CARD_STAGE: Record<QuoteStage, string> = {
  waiting_on_you: "Waiting on you",
  replied: "Replied, no price yet",
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
    /** Check 11 P6: the owner gave a price (else "Replied, no price yet"). */
    priced: boolean;
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

/**
 * Check 13 P6: when the customer themselves last wrote, in a plumber's words — "Wrote 3 hours
 * ago" under 30 days, then "Wrote in July" within the current year, else "Wrote Mar 2025" (the
 * owner's time zone).
 */
export function wroteWords(at: Date, now: Date, timeZone = "America/New_York"): string {
  if (now.getTime() - at.getTime() < 30 * 86_400_000) return `Wrote ${relativeTime(at, now)}`;
  const year = (d: Date) => d.toLocaleDateString("en-US", { year: "numeric", timeZone });
  if (year(at) === year(now))
    return `Wrote in ${at.toLocaleDateString("en-US", { month: "long", timeZone })}`;
  return `Wrote ${at.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone })}`;
}

/**
 * Check 13 P8: how far back Customers reaches — the first Gmail connect minus the 30-day read
 * on connect — as "Oct 2, 2026" in the owner's time zone. Null before any connect.
 */
export function listStartsOn(
  firstConnectedAt: Date | null,
  backfillDays: number,
  timeZone = "America/New_York",
): string | null {
  if (!firstConnectedAt) return null;
  return new Date(firstConnectedAt.getTime() - backfillDays * 86_400_000).toLocaleDateString(
    "en-US",
    { month: "short", day: "numeric", year: "numeric", timeZone },
  );
}
