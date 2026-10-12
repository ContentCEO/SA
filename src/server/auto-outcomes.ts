import "server-only";
import type { Classification } from "@/ai/classify";
import { autoMarkInvoicePaid, openInvoices } from "./money";
import {
  invoiceOf,
  isReceiptSender,
  matchReceipt,
  normalizeInvoiceNumber,
  type InvoiceFacts,
} from "./money-rules";
import { canAutoSet } from "./quote-rules";
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

  // Invoices (plan #27). Both are guesses: they stop future nudges, flag (never delete) a
  // waiting one, never touch an owner's mark (the guard is in the UPDATE), and show in
  // Activity with "Undo on Money owed".
  const invoice = invoiceOf(result.extracted);
  if (invoice?.status !== "paid") return;
  if (isReceiptSender(input.fromAddress)) {
    // A payment receipt (Stripe, QuickBooks): it only ever marks the ONE open invoice whose
    // number it names (and amount, when both say) — never its own thread, and never by
    // amount alone (A2, A12). A receipt sorted as supplier/vendor is for the owner's own
    // purchase, never a customer paying them.
    if (result.category === "supplier_vendor") return;
    if (!normalizeInvoiceNumber(invoice.invoice_number)) return;
    const match = matchReceipt(invoice, await openInvoices(input.workspaceId, threadId, now));
    if (match) await autoMarkInvoicePaid(match, "receipt", now);
    return;
  }
  // "Paid it this morning, thanks" on an invoice thread → paid (our guess).
  if (input.storedInvoice !== undefined && input.storedInvoice?.status !== "paid") return;
  if (
    previous.invoiceThread === true ||
    previous.category === "invoice_payment" ||
    result.category === "invoice_payment"
  ) {
    await autoMarkInvoicePaid(threadId, "reply", now);
  }
}
