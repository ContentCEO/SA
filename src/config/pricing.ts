/**
 * All prices in one place. Amounts are in US cents.
 * Changing anything here changes the commercial flow — ask Davi first.
 */
export const pricing = {
  setupFee: { name: "Setup", amountCents: 49_900 },
  plans: {
    solo: { name: "Solo", amountCents: 9_900, mailboxLimit: 1, autopilot: false },
    crew: { name: "Crew", amountCents: 19_900, mailboxLimit: 3, autopilot: true },
    company: { name: "Company", amountCents: 29_900, mailboxLimit: 10, autopilot: true },
  },
  evaluationDays: 3,
} as const;

export type PlanId = keyof typeof pricing.plans;

/**
 * Plan #47 referral credit, in US cents, added to the Stripe balance once per referral when the
 * referred account becomes active. ASK DAVI — no number picked. While this is null, referrals do
 * nothing at all, even with FEATURE_REFERRALS on.
 */
export const REFERRAL_CREDIT_CENTS: number | null = null;

/** Plan #47: who gets the credit. "both" is the spec's default. ASK DAVI before changing. */
export const REFERRAL_CREDIT_TO: "both" | "referrer" | "referred" = "both";

export function formatDollars(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}
