import "server-only";
import type { Classification } from "@/ai/classify";
import { canAutoSet } from "./quote-rules";
import { autoSetQuoteOutcome, clearNoAnswerGuess } from "./quotes";

/**
 * Marks we make by ourselves after an email is sorted (plan #30; invoices join in #27).
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
  };
  result: Classification;
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
}
