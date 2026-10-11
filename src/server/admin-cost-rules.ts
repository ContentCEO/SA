import { pricing, type PlanId } from "@/config/pricing";

/** Plan #45: alert Davi when one account's AI cost passes this share of its plan price. */
export const COST_ALERT_SHARE = 0.4;

/** Which statuses are actually paying the monthly plan. */
const PAYING = ["setup_paid", "active", "past_due"] as const;

export type CostInput = {
  status: string;
  plan: PlanId | null;
  /** This month's estimated AI cost, in hundredths of a cent. */
  costCentiCents: number;
};

export function planRevenueCents(w: Pick<CostInput, "status" | "plan">): number {
  if (!w.plan || !(PAYING as readonly string[]).includes(w.status)) return 0;
  return pricing.plans[w.plan].amountCents;
}

export function costLine(w: CostInput) {
  const costCents = Math.round(w.costCentiCents / 100);
  const revenueCents = planRevenueCents(w);
  return {
    costCents,
    revenueCents,
    marginCents: revenueCents - costCents,
    /** Cost as a share of the plan price; null when there's no paying plan. */
    costShare: revenueCents ? costCents / revenueCents : null,
  };
}

/** Over the line? Only for paying plans — a trial has no price to compare with. */
export function costAlertDue(w: CostInput): boolean {
  const { costShare } = costLine(w);
  return costShare !== null && costShare > COST_ALERT_SHARE;
}
