/**
 * Leads package (B6): "Not answered yet", as pure rules. A customer who wrote over a day ago
 * (and under two weeks) and hasn't heard back, with no card on the queue — the ones that slip.
 */
export const NOT_ANSWERED_AFTER_HOURS = 24;
export const NOT_ANSWERED_MAX_DAYS = 14;
export const NOT_ANSWERED_SHOWN = 5;

/** The categories a person waits on an answer for. */
export const NOT_ANSWERED_CATEGORIES = [
  "quote_request",
  "customer_question",
  "scheduling",
  "invoice_payment",
  "complaint",
] as const;

/** "waiting 3 days" / "waiting 1 day". */
export function waitingWords(since: Date, now: Date): string {
  const days = Math.max(1, Math.floor((now.getTime() - since.getTime()) / 86_400_000));
  return `waiting ${days} ${days === 1 ? "day" : "days"}`;
}

/** The morning email's count-only line. */
export function notAnsweredLine(n: number): string {
  return n === 1
    ? "1 customer has waited more than a day for an answer"
    : `${n} customers have waited more than a day for an answer`;
}
