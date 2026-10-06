import { pricing, type PlanId } from "@/config/pricing";
import type { Workspace } from "@/db/schema";
import { effectiveStatus } from "./lifecycle";

/**
 * How payments move a workspace through the commercial flow. Pure functions;
 * Stripe webhooks call them (never the browser redirect). Changing these
 * changes the commercial flow — Davi's call.
 *
 *   pay setup + plan  → setup_paid (sending on; setup call pending) → admin: active
 *   payment fails     → past_due (jobs pause, nothing deleted)
 *   payment recovers  → back to setup_paid / active
 *   subscription ends → canceled (read-only, nothing deleted)
 */
type W = Pick<
  Workspace,
  "status" | "evaluationEndsAt" | "setupPaidAt" | "setupCallCompletedAt" | "stripeSubscriptionId"
>;
type Status = Workspace["status"];

export const PLAN_IDS = Object.keys(pricing.plans) as PlanId[];
export function isPlanId(v: unknown): v is PlanId {
  return typeof v === "string" && (PLAN_IDS as string[]).includes(v);
}

/** Price lookup keys carry the amount, so a price change in config makes a new Stripe price. */
export const setupLookupKey = () => `sa_setup_${pricing.setupFee.amountCents}`;
export const planLookupKey = (plan: PlanId) =>
  `sa_${plan}_${pricing.plans[plan].amountCents}_month`;
export function planFromLookupKey(key: string | null | undefined): PlanId | null {
  const m = key?.match(/^sa_(solo|crew|company)_\d+_month$/);
  return m && isPlanId(m[1]) ? m[1] : null;
}

/** Where they go once paid: as far as they'd got, at least setup_paid. */
function restored(w: W): Status {
  return w.setupCallCompletedAt ? "active" : "setup_paid";
}

/** Who may start a checkout, and whether the one-time setup fee is included. */
export function checkoutTerms(w: W, now: Date = new Date()) {
  const status = effectiveStatus(w, now);
  const allowed = !w.stripeSubscriptionId && status !== "paused";
  return { allowed, includeSetupFee: !w.setupPaidAt };
}

export function statusAfterCheckout(w: W, now: Date = new Date()): Status {
  const status = effectiveStatus(w, now);
  if (status === "setup_paid" || status === "active") return status;
  return restored(w);
}

/** Stripe subscription status → our status. Unknown/in-between states change nothing. */
export function statusAfterSubscription(
  w: W,
  stripeStatus: string,
  now: Date = new Date(),
): Status {
  const status = effectiveStatus(w, now);
  switch (stripeStatus) {
    case "active":
    case "trialing":
      return status === "past_due" || status === "canceled" ? restored(w) : status;
    case "past_due":
    case "unpaid":
      return status === "setup_paid" || status === "active" ? "past_due" : status;
    case "canceled":
    case "incomplete_expired":
      return status === "setup_paid" || status === "active" || status === "past_due"
        ? "canceled"
        : status;
    default:
      return status;
  }
}
