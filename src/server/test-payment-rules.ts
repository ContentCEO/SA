import type { Workspace } from "@/db/schema";
import { restored } from "./billing-rules";

/**
 * "Reset test payments" (Davi, 2026-10-14): accounts that "paid" with a Stripe test card are put
 * back where an unpaid account stands, so they pay for real once Stripe is live. Pure rules; the
 * Stripe checks and the database side are in `test-payments.ts`.
 *
 * It follows the "Sending requires a real payment" precedent (2026-10-10): an account without
 * `setup_paid_via` can't send, sees "Sending turns on once your setup payment goes through", and
 * pays the setup fee at checkout. No new statuses or rules. Like those hand-marked accounts, a
 * reset one keeps `setup_paid_at`: Resume (`resumeTarget`) reads it to bring a paused account back
 * to where it was, and nothing reads it as "paid" (`setupReallyPaid` reads `setup_paid_via`).
 */

type W = Pick<
  Workspace,
  "status" | "setupPaidVia" | "setupCallCompletedAt" | "stripeCustomerId" | "stripeSubscriptionId"
>;

/**
 * What live Stripe said about one stored id: there's none, Stripe doesn't know it (it was made
 * in test mode: `resource_missing`), it's a live record (a deleted live customer included), or
 * Stripe couldn't be asked.
 */
export type IdCheck = "none" | "test" | "live" | "unknown";
export type AccountCheck = { customer: IdCheck; subscription: IdCheck };

/** Accounts worth asking Stripe about: any Stripe id, or a setup paid through Stripe. */
export function mayCarryTestPayment(
  w: Pick<W, "stripeCustomerId" | "stripeSubscriptionId" | "setupPaidVia">,
): boolean {
  return !!w.stripeCustomerId || !!w.stripeSubscriptionId || w.setupPaidVia === "stripe";
}

export type TestPaymentReset = {
  set: Pick<Workspace, "status" | "setupPaidVia" | "stripeCustomerId" | "stripeSubscriptionId">;
  /** Content-free, for the activity row. */
  detail: {
    customerCleared: boolean;
    subscriptionCleared: boolean;
    setupPaymentCleared: boolean;
    statusRestored: boolean;
  };
};

/**
 * What a reset changes for one account: "unchecked" when Stripe couldn't answer for one of its
 * ids (then nothing changes — nothing is half-done), null when it carries no test-mode payment.
 *
 * - Test-mode customer / subscription ids are cleared (live Stripe can't use them).
 * - A setup paid through Stripe is cleared (`setup_paid_via` → null) unless a live customer or
 *   subscription is left: a live payment always leaves a customer, so a "stripe" setup with no
 *   ids at all was paid in test mode too. `setup_paid_at` stays (see above); the next real
 *   payment records its own date.
 * - House accounts keep "house"; only their test-mode ids go.
 * - Status: setup_paid and active stay (the 2026-10-10 precedent: they can't send until they
 *   pay). past_due becomes what a recovered payment restores, because a test subscription can
 *   never be paid and "Update payment" needs a live customer. Everything else is unchanged.
 * - The plan stays; the next checkout sets it.
 */
export function testPaymentReset(w: W, check: AccountCheck): TestPaymentReset | "unchecked" | null {
  if (check.customer === "unknown" || check.subscription === "unknown") return "unchecked";
  const customerCleared = check.customer === "test";
  const subscriptionCleared = check.subscription === "test";
  const liveRecordLeft = check.customer === "live" || check.subscription === "live";
  const setupPaymentCleared = w.setupPaidVia === "stripe" && !liveRecordLeft;
  if (!customerCleared && !subscriptionCleared && !setupPaymentCleared) return null;
  const statusRestored = w.status === "past_due" && check.subscription !== "live";
  return {
    set: {
      status: statusRestored ? restored(w) : w.status,
      setupPaidVia: setupPaymentCleared ? null : w.setupPaidVia,
      stripeCustomerId: customerCleared ? null : w.stripeCustomerId,
      stripeSubscriptionId: subscriptionCleared ? null : w.stripeSubscriptionId,
    },
    detail: { customerCleared, subscriptionCleared, setupPaymentCleared, statusRestored },
  };
}

/** The last check or reset, as kept for the /admin Payments card. Counts only. */
export type TestPaymentsResult = {
  /** Accounts that still carry a test-mode payment. */
  found: number;
  /** Accounts Stripe couldn't answer for (or that changed while we looked): left as they were. */
  unchecked: number;
  /** Set by a reset: how many accounts it reset. Null after a plain check. */
  reset: number | null;
  at: string;
};

const accounts = (n: number) => `${n} account${n === 1 ? "" : "s"}`;
const uncheckedLine = (n: number) => (n > 0 ? ` Couldn't check ${accounts(n)}. Tap again.` : "");

/**
 * The reset's one status change, said plainly on the /admin confirm and in LAUNCH.md 7c (review,
 * 2026-10-15): a past_due account leaves read-only (jobs and AI resume) without a payment, and
 * still can't send. Davi decided on 2026-10-16: "let it be usable" (kept as built).
 */
export const PAST_DUE_RESET_NOTE =
  "An account that was past due is switched back on: its new mail is sorted and drafted again (on your AI bill), but it still can't send until it pays.";

/** Shown in test mode instead of the buttons. */
export const TEST_PAYMENTS_TEST_MODE =
  "Reset test payments shows up after you switch Stripe to live mode.";

/** The Payments card's line after a check or a reset. */
export function testPaymentsLine(r: Pick<TestPaymentsResult, "found" | "unchecked">): string {
  const found =
    r.found > 0
      ? `Test payments: ${accounts(r.found)} still ${r.found === 1 ? "carries" : "carry"} a test-mode payment.`
      : r.unchecked > 0
        ? "Test payments: none found so far."
        : "Test payments: none left.";
  return found + uncheckedLine(r.unchecked);
}

/** The notice after "Reset test payments". */
export function testPaymentsResetNotice(
  r: Pick<TestPaymentsResult, "unchecked"> & { reset: number },
) {
  return `Test payments reset for ${accounts(r.reset)}.${uncheckedLine(r.unchecked)}`;
}

/** Reads a stored result back; anything malformed counts as never checked. */
export function parseTestPaymentsResult(
  value: string | null | undefined,
): TestPaymentsResult | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value) as Partial<TestPaymentsResult>;
    const count = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0;
    if (!count(v.found) || !count(v.unchecked) || typeof v.at !== "string") return null;
    if (v.reset !== null && !count(v.reset)) return null;
    if (Number.isNaN(Date.parse(v.at))) return null;
    return { found: v.found!, unchecked: v.unchecked!, reset: v.reset ?? null, at: v.at };
  } catch {
    return null;
  }
}
