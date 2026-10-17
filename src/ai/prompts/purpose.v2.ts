/**
 * Purpose tasks, version 2 (Sonnet; 2026-10-16). Adds the thank-you for a paid invoice ("Say
 * thanks" on Money, Davi): a short thank-you, and — only when every review-request rule allows
 * it for this customer and the owner has a review link — the review ask in the same note.
 *
 * The deposit, review request and closing question tasks are purpose.v1's, unchanged (re-exported
 * so there is one copy of each). As in v1, only the conversation's closing task changes: the
 * system instructions stay the drafting prompt's and the cached business block is the same.
 */
import { PURPOSE_MARKER } from "./purpose.v1";

export {
  closingQuestionTask,
  DEPOSIT_GAP,
  depositTask,
  PURPOSE_MARKER,
  reviewRequestTask,
} from "./purpose.v1";

export const PURPOSE_PROMPT_VERSION = "purpose.v2";

/**
 * The customer has paid. `reviewUrl` is set only when the server decided a review ask is allowed
 * (no complaint in 12 months, a known customer, not a robot or a receipt, not a supplier, not
 * injection or municipal mail, none asked in 12 months) and the owner has a link; otherwise the
 * note asks for nothing.
 */
export function thankYouTask(o: { reviewUrl: string | null }): string {
  const ask = o.reviewUrl
    ? `- Then ask whether they'd leave a short review, at exactly this link, written on its own line: ${o.reviewUrl}
- No other link. No discount, gift, coupon, freebie or anything else in return. No pressure, no guilt, no follow-up promised.`
    : `- Ask for nothing: no review, no referral, no link, no new work.`;
  return `${PURPOSE_MARKER} thank you
Write a short note from the owner to the CUSTOMER in this conversation: they have paid the invoice.
- Thank them for the payment, warmly and plainly. ${o.reviewUrl ? "70" : "50"} words at most, plus greeting and sign-off.
${ask}
- Don't mention any amount, price, invoice number, way to pay, discount or new work. Don't say the payment "cleared" or arrived on a certain day.`;
}
