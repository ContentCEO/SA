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
 * Check 35 P3: what the one-time setup call covers, said the same way everywhere (homepage,
 * /billing before and after paying, the setup_paid banner). Only things the business profile
 * stores (prices, hours, service area, never-promise list).
 */
export const SETUP_CALL_COVERS = [
  "your prices",
  "hours",
  "service area",
  "the things you never promise",
] as const;

/**
 * The sentence after each place's own lead-in: "before" follows "a call with us to …", "after"
 * follows "{operator} …" once it's paid.
 */
export function setupCallSentence(kind: "before" | "after"): string {
  const items = [...SETUP_CALL_COVERS];
  const list = `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  return kind === "before"
    ? `load ${list}, then tune your drafts until they sound like you`
    : `loads ${list}, then tunes your drafts until they sound like you`;
}

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

/**
 * Check 17 P2: the paused banner's extra sentence while a Stripe plan is still on file. Pausing
 * only changes our status; Stripe keeps billing until Davi pauses or cancels it there.
 */
export const PAUSED_STILL_BILLED_LINE = "Your plan's billing hasn't changed.";

/** Shown instead when the status would allow sending but the setup was never really paid. */
export const SETUP_NOT_PAID_LINE = "Sending turns on once your setup payment goes through.";

/** "Nov 16" in the owner's time zone (Eastern when the zone is unknown or invalid). */
export function shortDate(d: Date, timeZone = "America/New_York"): string {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(d);
  try {
    return fmt(timeZone);
  } catch {
    return fmt("America/New_York");
  }
}

/** The owner's local calendar date ("2026-11-16"), for content-free activity rows. */
export function localDateKey(d: Date, timeZone = "America/New_York"): string {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  try {
    return fmt(timeZone);
  } catch {
    return fmt("America/New_York");
  }
}

/** Check 17 P11: Davi's own house account — nothing is billed. */
export const HOUSE_ACCOUNT_LINE = "Your own test account. Nothing is billed.";
/** Check 17 P11: a Stripe-paid setup with no subscription on file (cleared or never attached). */
export const NO_STRIPE_PLAN_LINE =
  "There's no Stripe plan attached to this account. Call Davi to sort it out.";

/**
 * Check 17 P11: set up for real but nothing in Stripe to renew or change (Davi's house account, or
 * a Stripe-paid setup whose subscription id was cleared). /billing hides the offer to buy and the
 * "What happens next" box for these; checkoutTerms and the commercial flow are unchanged.
 */
export function setUpWithoutStripePlan(
  w: Pick<W, "status" | "evaluationEndsAt" | "setupPaidVia" | "stripeSubscriptionId">,
  now: Date = new Date(),
): boolean {
  const status = effectiveStatus(w, now);
  if (!SENDING_ALLOWED.includes(status) || !setupReallyPaid(w)) return false;
  return w.setupPaidVia === "house" || !w.stripeSubscriptionId;
}

/** Check 17 P3: what /billing says once the owner canceled and the plan runs out on a date. */
export const planEndsLine = (date: string) =>
  `Your plan ends on ${date}. Nothing is deleted. Changed your mind? Manage billing keeps it going.`;

/**
 * What /billing says about the account. An account at setup_paid / active whose setup wasn't
 * really paid (marked by hand before 2026-10-10, or reset after a test card) gets the same words
 * as the banner and the queue, never "Setup's paid" or "renews monthly": it can't send, and has
 * no subscription to renew. Check 17 P3: a canceled plan still running says when it ends.
 */
export function billingStatusLine(
  w: Pick<W, "status" | "evaluationEndsAt" | "setupPaidVia"> & {
    planEndsAt?: Date | null;
    stripeSubscriptionId?: string | null;
  },
  now: Date = new Date(),
  timeZone = "America/New_York",
): string | null {
  const status = effectiveStatus(w, now);
  if (SENDING_ALLOWED.includes(status) && !setupReallyPaid(w)) return SETUP_NOT_PAID_LINE;
  // Check 17 P11: never "renews monthly" when there's nothing to renew.
  if (SENDING_ALLOWED.includes(status) && w.setupPaidVia === "house") return HOUSE_ACCOUNT_LINE;
  if (SENDING_ALLOWED.includes(status) && !w.stripeSubscriptionId) return NO_STRIPE_PLAN_LINE;
  if (SENDING_ALLOWED.includes(status) && w.planEndsAt) {
    return planEndsLine(shortDate(w.planEndsAt, timeZone));
  }
  return BILLING_STATUS_LINES[status] ?? null;
}

/** Check 17 P3: the banner's quiet reminder shows in the last 7 days before the plan ends. */
export const PLAN_ENDING_SOON_MS = 7 * 86_400_000;
export function planEndingSoon(planEndsAt: Date | null | undefined, now: Date): boolean {
  if (!planEndsAt) return false;
  const left = planEndsAt.getTime() - now.getTime();
  return left > 0 && left <= PLAN_ENDING_SOON_MS;
}

/**
 * Check 17 P3: when a live subscription stops, from Stripe's own fields: `cancel_at` first, else
 * the period end when only `cancel_at_period_end` is set (in this API version the period dates
 * live on the subscription's first item). Null when nothing is scheduled or it already ended.
 */
export function planEndsAtFrom(sub: {
  status: string;
  cancel_at?: number | null;
  cancel_at_period_end?: boolean | null;
  items?: { data?: Array<{ current_period_end?: number | null } | undefined> } | null;
}): Date | null {
  if (sub.status === "canceled" || sub.status === "incomplete_expired") return null;
  if (sub.cancel_at) return new Date(sub.cancel_at * 1000);
  if (sub.cancel_at_period_end) {
    const end = sub.items?.data?.[0]?.current_period_end;
    return end ? new Date(end * 1000) : null;
  }
  return null;
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
