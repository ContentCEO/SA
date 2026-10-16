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

/** Plans from smallest to largest ("the plan above yours", plan #47). */
export const PLAN_ORDER: readonly PlanId[] = ["solo", "crew", "company"];

/** A plan's place in PLAN_ORDER; no plan ranks below every plan. */
export function planRank(plan: PlanId | null | undefined): number {
  return plan ? PLAN_ORDER.indexOf(plan) : -1;
}

/** The plan one up: Solo → Crew, Crew → Company, Company → Company. */
export function planAbove(plan: PlanId): PlanId {
  return PLAN_ORDER[Math.min(planRank(plan) + 1, PLAN_ORDER.length - 1)]!;
}

/** Inboxes a plan includes. Before a plan is chosen (evaluation), a workspace gets one. */
export function mailboxLimitFor(plan: PlanId | null | undefined): number {
  return plan ? pricing.plans[plan].mailboxLimit : 1;
}

/** Whether a plan comes with autopilot (Crew and Company). */
export function planHasAutopilot(plan: PlanId | null | undefined): boolean {
  return !!plan && pricing.plans[plan].autopilot;
}

/**
 * Plan #47 (Davi, 2026-10-15, offer A): when someone you referred has paid and is active, your
 * next month is free on the plan above yours; afterwards you go back to your own plan unless you
 * tap Keep (normal price). Only the referrer is rewarded (Davi, 2026-10-13). One free month at a
 * time, no yearly cap (Davi, 2026-10-16). Nothing happens unless FEATURE_REFERRALS is on too.
 * Ask Davi before changing.
 */
export const REFERRAL_REWARD: "free_month_one_plan_up" | null = "free_month_one_plan_up";

export function formatDollars(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}
