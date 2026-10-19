import "server-only";
import type { Classification } from "@/ai/classify";
import { autoMarkInvoicePaid, openInvoices, settleByReceipt } from "./money";
import {
  invoiceOf,
  isReceiptSender,
  matchReceipt,
  normalizeInvoiceNumber,
  type InvoiceFacts,
} from "./money-rules";
import { canAutoSet, DECLINED_FLAG } from "./quote-rules";
import { autoSetQuoteOutcome, clearNoAnswerGuess } from "./quotes";

/**
 * Marks we make by ourselves after an email is sorted (plan #30 quotes, #27 invoices).
 * Each one is a guess the owner can change with one tap, never touches anything the
 * owner set (the guard lives in the UPDATE), and is idempotent — so a retry after a
 * crash is harmless. Read-only accounts never get here: classifyPending stops first.
 */
export async function afterClassified(input: {
  workspaceId: string;
  threadId: string;
  fromAddress: string | null;
  /** The thread as it was BEFORE this email (its category may just have been overwritten). */
  previous: {
    category: string | null;
    quoteOutcome: string | null;
    quoteOutcomeSource: string | null;
    /** Was about an invoice before this email (isInvoiceThread). */
    invoiceThread?: boolean;
    /**
     * Had an invoice waiting to be paid before this email (`invoiceWasOpen` on the stored
     * facts; an amount isn't needed). Only then can the customer's "paid" mark the thread
     * paid — "Let's do it, sent the $500 deposit" is the first invoice fact on a quote
     * thread, not the job being paid.
     */
    openInvoice?: boolean;
    /** Check 21 P2: was a quote before this email (sorted one, sticky request time or an outcome). */
    quoteRequested?: boolean;
  };
  result: Classification;
  /**
   * The thread's invoice facts as stored after this email (carryInvoiceFacts). "Paid #41"
   * while #42 is the thread's current invoice settles #41 only, so the thread stays owed.
   */
  storedInvoice?: InvoiceFacts | null;
  now: Date;
}): Promise<void> {
  const { result, threadId, now, previous } = input;

  // The customer wrote back, so our "no answer" guess was wrong: the quote is open again
  // and can be chased again. Not a mark but a fact about the thread, so it holds whatever
  // the email says (even an injection attempt only re-opens it). Never an owner's mark:
  // the guard is in the UPDATE.
  if (previous.quoteOutcome === "no_answer" && previous.quoteOutcomeSource === "auto") {
    await clearNoAnswerGuess(threadId);
  }

  // An email that tries to instruct the assistant never marks anything by itself (A8).
  if (result.extracted.injection === true) return;

  // "Let's do it" on a quote the owner gave → won. `quote_accepted` was decided at
  // classification from the thread's previous category/outcome, an owner reply before it
  // and no injection (quoteAccepted); requiring this email's own signal too means a flag
  // merely carried over from an earlier email never re-marks the quote.
  // canAutoSet is an early skip; the SQL guard in autoSetQuoteOutcome is what decides.
  if (
    result.extracted.accepts_quote === true &&
    result.extracted.quote_accepted === true &&
    canAutoSet(previous.quoteOutcome, previous.quoteOutcomeSource)
  ) {
    await autoSetQuoteOutcome(threadId, "won", now, { why: "accepted" });
  }

  // Check 21 P2: "We went with someone else, thanks." on a quote → lost (our guess). The owner
  // always wins (canAutoSet here, the same rule in the UPDATE); a waiting nudge is flagged
  // "They said no. Check before sending." and no new one is drafted (a decided quote).
  if (
    result.extracted.declines_quote === true &&
    (previous.quoteRequested === true ||
      previous.category === "quote_request" ||
      result.category === "quote_request") &&
    canAutoSet(previous.quoteOutcome, previous.quoteOutcomeSource)
  ) {
    await autoSetQuoteOutcome(threadId, "lost", now, { why: "declined", flag: DECLINED_FLAG });
  }

  // Invoices (plan #27). Both are guesses: they stop future nudges, flag (never delete) a
  // waiting one, never touch an owner's mark (the guard is in the UPDATE), and show in
  // Activity with "Undo on Money owed".
  const invoice = invoiceOf(result.extracted);
  if (!invoice) return;
  // Check 12 P2: payments that add up to the full amount ("sent the last $3,000") read as paid
  // on the stored facts (carryInvoiceFacts): our paid guess, never a silent drop. Check 12 P3:
  // "the check is in the mail" (said_sent) is a promise, never a paid mark.
  const settledByPayments =
    (invoice.amount_paid_now ?? 0) > 0 &&
    input.storedInvoice != null &&
    input.storedInvoice.status === "paid" &&
    (input.storedInvoice.paid ?? 0) > 0;
  if (invoice.status !== "paid" && !settledByPayments) return;
  if (isReceiptSender(input.fromAddress)) {
    // A payment receipt (Stripe, QuickBooks): it only ever marks the ONE open invoice whose
    // number it names (and amount, when both say) — never its own thread, and never by
    // amount alone (A2, A12). A receipt sorted as supplier/vendor is for the owner's own
    // purchase, never a customer paying them.
    if (result.category === "supplier_vendor") return;
    // Check 12 P4: a receipt for a bill the owner paid (a supplier's bill 1037) is never a
    // customer paying the owner's invoice 1037 — QuickBooks numbers everyone's from 1001.
    if (result.extracted.invoice_direction === "owed_by_business") return;
    if (!normalizeInvoiceNumber(invoice.invoice_number)) return;
    // …and without an amount on the receipt, a number alone never marks anything. (Check 12
    // P2: a receipt's figure may be read as the payment rather than the invoice total.)
    const receiptAmount = invoice.amount ?? invoice.amount_paid_now ?? null;
    if (!(receiptAmount && receiptAmount > 0)) return;
    const open = await openInvoices(input.workspaceId, threadId, now);
    const match = matchReceipt(invoice, open);
    if (match) {
      // Earlier invoices still open on that thread: the oldest becomes current, not paid.
      await settleByReceipt(match, open.find((o) => o.threadId === match)?.invoice ?? null, now);
    }
    return;
  }
  // "Paid it this morning, thanks" on a thread with an invoice waiting → paid (our guess).
  // Never when this email is the thread's first invoice fact (a deposit on a quote thread is
  // not the job being paid; its facts are stored, nothing is marked), and never while an
  // earlier invoice is still open (the stored facts then say unpaid: promoteEarlierOpen).
  if (previous.openInvoice !== true) return;
  if (input.storedInvoice !== undefined && input.storedInvoice?.status !== "paid") return;
  if (
    previous.invoiceThread === true ||
    previous.category === "invoice_payment" ||
    result.category === "invoice_payment"
  ) {
    await autoMarkInvoicePaid(threadId, "reply", now);
  }
}
