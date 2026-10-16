/**
 * Purpose tasks, version 1 (Sonnet; plan #26 #28 #29). A special reply the owner will
 * read before it goes: deposit details on an accepted quote, a review request after a
 * finished job, or one "did you go another way?" question on a quiet quote.
 *
 * Only the conversation's closing task changes. The system instructions stay the
 * drafting prompt's (DRAFT_INSTRUCTIONS, draft.v5) and the cached business block is
 * the same, so caching still works. Every task starts with PURPOSE_MARKER and a name,
 * so the eval stand-in can tell them apart.
 */
export const PURPOSE_PROMPT_VERSION = "purpose.v1";

export const PURPOSE_MARKER = "## Task:";

/** The gap a deposit draft gets when the owner has no payment terms (never a made-up method). */
export const DEPOSIT_GAP = "{{custom:deposit instructions}}";

export function depositTask(o: { paymentTerms: string | null }): string {
  const terms = o.paymentTerms?.trim();
  return `${PURPOSE_MARKER} deposit
Write the owner's reply to the last CUSTOMER message. The customer has accepted the quote.
- Thank them, plainly and briefly.
- Confirm the next steps without inventing any date, day, time or start window. If a date is needed, use a {{date}} gap.
${
  terms
    ? `- Say how to pay the deposit using ONLY the "Payment terms" line of the business block. Where it states an amount, a percentage or a payment method, use its words exactly. Add no other amount, percentage, method, discount or condition.`
    : `- There are no payment terms. Do not describe any deposit, amount or method; put the gap ${DEPOSIT_GAP} on its own line where they would go.`
}
- Never offer a discount or anything extra.
- Add a flag if anything about the payment needs the owner to check.`;
}

export function reviewRequestTask(o: { reviewUrl: string }): string {
  return `${PURPOSE_MARKER} review request
Write a short note from the owner to the CUSTOMER in this conversation: the job is done and they seem happy.
- Thank them warmly and plainly. 70 words at most, plus greeting and sign-off.
- Ask whether they'd leave a short review, at exactly this link, written on its own line: ${o.reviewUrl}
- No other link. No discount, gift, coupon, freebie or anything else in return. No pressure, no guilt, no follow-up promised.
- Don't mention prices, invoices or new work.`;
}

export function closingQuestionTask(o: { daysQuiet: number }): string {
  return `${PURPOSE_MARKER} closing question
The owner sent the last message in this conversation, a quote, and has already followed up. The customer hasn't replied for ${o.daysQuiet} days.
Write ONE short, no-pressure message from the owner asking whether they went another way or the timing changed.
- Make it easy to say no: either answer is fine, and a one-word reply is plenty.
- Offer nothing new: no price, no discount, no new date, no guarantee.
- It must not read as another follow-up or a reminder. Never "just checking in", never "following up".
- Two or three sentences, plus greeting and sign-off.`;
}
