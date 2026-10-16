import { formatDollars, pricing, type PlanId } from "@/config/pricing";
import type { Workspace } from "@/db/schema";
import { effectiveStatus, SENDING_ALLOWED, setupReallyPaid } from "./lifecycle";

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
  | "status"
  | "evaluationEndsAt"
  | "setupPaidAt"
  | "setupPaidVia"
  | "setupCallCompletedAt"
  | "stripeSubscriptionId"
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

/**
 * Sales tax (Davi, 2026-10-14: "turn on Stripe Tax"). Davi sets Stripe Tax up in Stripe's
 * dashboard; the app only notices whether it's active. "unknown" = Stripe couldn't be asked.
 */
export type SalesTaxStatus = "on" | "off" | "unknown";

/** The /admin Payments line for each state. Content-free. */
export const SALES_TAX_LINES: Record<SalesTaxStatus, string> = {
  on: "Sales tax: on (Stripe Tax is set up).",
  off: "Sales tax: off. Set up Stripe Tax in Stripe to charge it.",
  unknown: "Sales tax: couldn't check.",
};

/**
 * Shown under "on": Stripe calls tax "active" once the business address is saved, which only
 * means it can work tax out. It charges tax only in the states registered in Stripe.
 */
export const SALES_TAX_ON_NOTE =
  "Stripe only charges it in the states listed in Stripe under Tax → Registrations.";

/** The owner-facing note next to plan prices (homepage and /billing). */
export const SALES_TAX_NOTE = "Plus sales tax where it applies.";

/**
 * Round 2 (FW): the first charge, said plainly before Stripe's page, from the config: the plan's
 * first month plus the one-time setup fee when it's still due, then the monthly price. Tax is
 * on top (prices are tax-exclusive), so it says so.
 */
export function firstChargeLine(plan: PlanId, includeSetupFee: boolean): string {
  const month = pricing.plans[plan].amountCents;
  const fmt = (c: number) => formatDollars(c);
  if (!includeSetupFee) {
    return `Your first payment is ${fmt(month)} for the first month, plus sales tax where it applies. Then ${fmt(month)} a month.`;
  }
  const setup = pricing.setupFee.amountCents;
  return `Your first payment is ${fmt(setup + month)}: ${fmt(setup)} for setup and ${fmt(month)} for the first month, plus sales tax where it applies. Then ${fmt(month)} a month.`;
}

/**
 * The /admin Payments line when a checkout had to go without Stripe's "I agree" box (Davi,
 * 2026-10-15): Stripe needs the terms link saved in its dashboard first. Shown until a later
 * checkout has the box again.
 */
export const TERMS_BOX_OFF_LINE =
  "Terms box at checkout: off. Add your terms link in Stripe → Settings → Business → Public details.";

/**
 * Which Stripe account mode a secret key talks to: live for `sk_live_` / `rk_live_` (standard or
 * restricted), test for anything else that's set, null when unset. The one place that decides it.
 */
export function stripeKeyMode(key: string | null | undefined): "live" | "test" | null {
  if (!key) return null;
  return /^(sk|rk)_live_/.test(key) ? "live" : "test";
}

/**
 * A signed webhook event from the other Stripe mode than the key's: a live key ignores test-mode
 * events, and a test key live ones. No key counts as test mode, and so does an event without
 * `livemode` (Stripe always sends it).
 */
export function eventFromOtherMode(
  livemode: boolean | null | undefined,
  keyMode: "live" | "test" | null,
): boolean {
  return (livemode === true) !== (keyMode === "live");
}

/** Where they go once paid: as far as they'd got, at least setup_paid. */
export function restored(w: Pick<W, "setupCallCompletedAt">): Status {
  return w.setupCallCompletedAt ? "active" : "setup_paid";
}

/** The /billing line under the current plan, by status. */
const BILLING_STATUS_LINES: Partial<Record<Status, string>> = {
  setup_paid: "Setup's paid and sending is on. We'll call to finish setting you up.",
  active: "All set. Your plan renews monthly.",
  past_due: "Your last payment didn't go through. Update your card to switch things back on.",
  canceled: "Your plan has ended. Pick a plan below to start again — nothing was deleted.",
};

/** Shown instead when the status would allow sending but the setup was never really paid. */
export const SETUP_NOT_PAID_LINE = "Sending turns on once your setup payment goes through.";

/**
 * What /billing says about the account. An account at setup_paid / active whose setup wasn't
 * really paid (marked by hand before 2026-10-10, or reset after a test card) gets the same words
 * as the banner and the queue, never "Setup's paid" or "renews monthly": it can't send, and has
 * no subscription to renew.
 */
export function billingStatusLine(
  w: Pick<W, "status" | "evaluationEndsAt" | "setupPaidVia">,
  now: Date = new Date(),
): string | null {
  const status = effectiveStatus(w, now);
  if (SENDING_ALLOWED.includes(status) && !setupReallyPaid(w)) return SETUP_NOT_PAID_LINE;
  return BILLING_STATUS_LINES[status] ?? null;
}

/** Who may start a checkout, and whether the one-time setup fee is included. */
export function checkoutTerms(w: W, now: Date = new Date()) {
  const status = effectiveStatus(w, now);
  const allowed = !w.stripeSubscriptionId && status !== "paused";
  // Only a real payment (or Davi's own account) skips the fee — an old hand-marked date doesn't.
  return { allowed, includeSetupFee: !setupReallyPaid(w) };
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
