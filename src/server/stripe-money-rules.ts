import { formatDollars } from "@/config/pricing";

/**
 * Check 17 P8: the words for refunds and card disputes. Pure: no database, no server-only.
 * Amounts and dates only; never card details or anything from an email.
 */

export type MoneyEventRow = {
  id: string;
  kind: "refund" | "dispute_opened" | "dispute_closed";
  amountCents: number;
  includesSetup: boolean;
  evidenceDueBy: Date | null;
  outcome: "won" | "lost" | null;
  createdAt: Date;
};

const day = (d: Date) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  }).format(d);

/** A dollar amount without ".00" for whole dollars ("$499", "$12.50"). */
const money = (cents: number) => formatDollars(cents);

/**
 * The /admin card lines: each refund, then each dispute (one line per dispute, its latest
 * state). An open dispute is `strong` (shown inverted) until it closes.
 */
export function moneyLines(rows: MoneyEventRow[]): Array<{ text: string; strong: boolean }> {
  const out: Array<{ text: string; strong: boolean }> = [];
  for (const r of rows) {
    if (r.kind !== "refund") continue;
    out.push({
      text: `Refunded ${money(r.amountCents)}${r.includesSetup ? " (setup)" : ""} on ${day(r.createdAt)}`,
      strong: false,
    });
  }
  const closed = new Map(rows.filter((r) => r.kind === "dispute_closed").map((r) => [r.id, r]));
  for (const r of rows) {
    if (r.kind !== "dispute_opened") continue;
    const end = closed.get(r.id);
    if (end) {
      out.push({
        text: `Card dispute closed${end.outcome ? `: ${end.outcome}` : ""} (${money(r.amountCents)})`,
        strong: false,
      });
    } else {
      out.push({
        text: `Card dispute open: answer by ${r.evidenceDueBy ? day(r.evidenceDueBy) : "the date in Stripe"}`,
        strong: true,
      });
    }
  }
  return out;
}

/** The /admin Payments line counting open disputes; null when none. */
export function openDisputesLine(n: number): string | null {
  if (n <= 0) return null;
  return n === 1
    ? "1 card dispute is open. Answer it in Stripe before the date on its card."
    : `${n} card disputes are open. Answer them in Stripe before the dates on their cards.`;
}

/** The owner's activity sentence for a refund (no dispute sentence on purpose). */
export function refundSentence(amountCents: unknown): string {
  return typeof amountCents === "number" && amountCents > 0
    ? `Refunded ${money(amountCents)} to your card`
    : "A refund went back to your card";
}

/** Davi's email about a new dispute: the business name, amount, answer-by date and a link. */
export function disputeNoticeCopy(o: {
  businessName: string | null;
  amountCents: number;
  dueBy: Date | null;
  dashboardUrl: string;
}) {
  return {
    subject: "A card dispute was opened",
    serif: "a dispute,",
    heavy: "answer it in Stripe.",
    lines: [
      `${o.businessName ?? "An owner with no business name yet"} disputed a ${money(o.amountCents)} charge with their card company.`,
      o.dueBy
        ? `Stripe needs your answer by ${day(o.dueBy)}. Without one the money goes back to them, plus Stripe's dispute fee.`
        : "Stripe shows the answer-by date on the dispute. Without an answer the money goes back to them, plus Stripe's dispute fee.",
    ],
    button: { label: "Open the dispute in Stripe", url: o.dashboardUrl },
    footer: "Nothing in Squared Away changed. Their account is as it was.",
  };
}
