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

/** Check 17 P7: in place of the plan picker when Stripe has a subscription for the account. */
export const PLAN_SET_BY_STRIPE_LINE =
  "Plan is set by their Stripe subscription. Change it in Stripe, or they can use Manage billing.";

/** Check 17 P7: the plan's name from the price list ("Crew"), not its id. */
export function planName(plan: string | null, plans: Record<string, { name: string }>): string {
  if (!plan) return "None yet";
  return plans[plan]?.name ?? plan;
}

/** Check 17 P4: on a card whose account has two live Stripe subscriptions. */
export const TWO_PLANS_LINE = "Two live Stripe plans: cancel one in Stripe";

/** Check 17 P4: in Payments, when a live plan or paid checkout matched no account here. */
export const ORPHAN_PLAN_LINE = "A Stripe plan has no account here. Check Stripe.";
