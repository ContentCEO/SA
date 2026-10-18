/**
 * Check 29 P8: Stripe's fees on each monthly plan charge, for the /admin/costs margin only.
 * This is NOT pricing (src/config/pricing.ts is): nothing here changes what owners pay.
 * Checked 2026-10-18 against https://stripe.com/pricing (US cards: 2.9% + 30¢ per successful
 * charge; Stripe Billing pay-as-you-go: 0.7% of billing volume). Stripe Tax's fee is left out
 * until Davi confirms his rate (`taxPercent: null`).
 */
export const STRIPE_FEES = {
  cardPercent: 0.029,
  cardFixedCents: 30,
  billingPercent: 0.007,
  taxPercent: null as number | null,
  checkedOn: "2026-10-18",
  source: "https://stripe.com/pricing",
} as const;

/** Stripe's fees on one charge of this many cents, rounded to the nearest cent. */
export function stripeFeeCents(chargeCents: number): number {
  if (chargeCents <= 0) return 0;
  const percent =
    STRIPE_FEES.cardPercent + STRIPE_FEES.billingPercent + (STRIPE_FEES.taxPercent ?? 0);
  return Math.round(chargeCents * percent + STRIPE_FEES.cardFixedCents);
}
