/**
 * Pure helpers for /admin wording and its "Needs you" box. No database, no server-only: the
 * page and the tests both use them.
 */

/** Check 17 P2: what Davi reads before pausing. Pausing never touches Stripe. */
export const PAUSE_EXPLAIN = "Stops reading, drafting and sending. Nothing is deleted.";
export const PAUSE_EXPLAIN_BILLED =
  "Stops reading, drafting and sending. Nothing is deleted. Their Stripe plan keeps charging. Pause or cancel it in Stripe if they shouldn't pay while paused.";

export function pauseExplanation(hasSubscription: boolean): string {
  return hasSubscription ? PAUSE_EXPLAIN_BILLED : PAUSE_EXPLAIN;
}

/** Check 17 P2: on a paused account's card while Stripe still has a live plan for it. */
export const STILL_BILLED_LINE = "Still billed in Stripe";
