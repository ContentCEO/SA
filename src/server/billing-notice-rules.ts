/**
 * Check 1 P3 / Check 17 P5: the words for billing news — Davi's content-free notices, the
 * owner's "You're set up" email and the /billing lines for checkouts that didn't simply pay.
 * Pure: no database, no server-only.
 */

export type BillingChangeKind = "past_due" | "recovered" | "canceled";

/** Davi's notice when Stripe moves an account. Plan name and kind only; who it is stays on /admin. */
export function billingChangeNoticeCopy(o: {
  kind: BillingChangeKind;
  planName: string | null;
  adminUrl: string;
}) {
  const plan = o.planName ? ` on the ${o.planName} plan` : "";
  const byKind: Record<BillingChangeKind, { subject: string; heavy: string; line: string }> = {
    past_due: {
      subject: "A payment didn't go through",
      heavy: "a card failed.",
      line: `An owner${plan} has a payment that didn't go through. Their account is paused until it's sorted. A call now often keeps them.`,
    },
    recovered: {
      subject: "A failed payment is sorted",
      heavy: "payment sorted.",
      line: `An owner${plan} sorted their payment. Their account is switched back on.`,
    },
    canceled: {
      subject: "A plan was canceled",
      heavy: "a plan ended.",
      line: `An owner${plan} ended their plan. Their account is read-only now; nothing was deleted.`,
    },
  };
  const k = byKind[o.kind];
  return {
    subject: k.subject,
    serif: "billing,",
    heavy: k.heavy,
    lines: [k.line, "Open the admin page to see who it is."],
    button: { label: "Open admin", url: o.adminUrl },
    footer: "Names and numbers stay in the admin page, not in this email.",
  };
}

/** The owner's one confirmation after paying for setup. Plan name only, no amounts. */
export function setupConfirmationCopy(o: {
  planName: string | null;
  operatorFirstName: string;
  phone: string;
  queueUrl: string;
}) {
  return {
    subject: "You're set up",
    serif: "you're set up,",
    heavy: "sending is on.",
    lines: [
      `Thanks for paying${o.planName ? ` for the ${o.planName} plan` : ""}. Sending is on now: every reply still waits for you to tap Send reply.`,
      `Next is your setup call. ${o.operatorFirstName} will call you to find a time. Rather pick it yourself? Call or text ${o.phone}.`,
    ],
    button: { label: "Open your queue", url: o.queueUrl },
    footer: "Stripe emails your receipt separately.",
  };
}

/** What happened to the last checkout that didn't simply pay, from the activity log. */
export type CheckoutNoticeKind =
  "payment_pending" | "payment_failed_bank" | "checkout_needs_review";

/** The actions that settle or replace a checkout notice (newest one wins). */
export const CHECKOUT_NOTICE_ACTIONS = [
  "payment_pending",
  "payment_failed_bank",
  "checkout_needs_review",
  "payment_received",
] as const;

/** The /billing line for each. */
export function checkoutNoticeLine(kind: CheckoutNoticeKind, operatorFirstName: string): string {
  switch (kind) {
    case "payment_pending":
      return "Your bank payment is on its way. Sending turns on when it clears, usually in a few business days.";
    case "payment_failed_bank":
      return "Your bank payment didn't go through. Choose a plan to try again.";
    case "checkout_needs_review":
      return `We've got your sign-up. ${operatorFirstName} will be in touch to switch sending on.`;
  }
}

/** On the /admin card when the newest checkout finished with nothing charged. */
export const CHECKOUT_REVIEW_LINE =
  "Checkout finished with nothing charged (a full discount?). Decide in Stripe.";

/** The newest of the notice actions decides; a payment received clears it. */
export function checkoutNoticeFrom(
  latestAction: string | null | undefined,
): CheckoutNoticeKind | null {
  return latestAction === "payment_pending" ||
    latestAction === "payment_failed_bank" ||
    latestAction === "checkout_needs_review"
    ? latestAction
    : null;
}

/** Check 17 P9: what the waiting page says once its refreshes run out. */
export const stripeGiveUpLine = (operatorFirstName: string) =>
  `Stripe has your payment, but our side hasn't caught up yet. You don't need to pay again. ${operatorFirstName} has been told and will sort it out today.`;

/** Check 17 P9: /admin Payments while any owner paid but no Stripe notice arrived. */
export const stripeWaitingLine = (n: number) =>
  `An owner paid but no Stripe notice arrived (${n}). Check Stripe → Developers → Webhooks.`;

/** Check 17 P9: on that account's /admin card. */
export const PAID_WAITING_LINE = "Paid, waiting on Stripe";
