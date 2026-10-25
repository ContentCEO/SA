import { createHash, randomBytes } from "node:crypto";
import type Stripe from "stripe";
import { featureOn } from "@/config/features";
import {
  formatDollars,
  mailboxLimitFor,
  planAbove,
  planHasAutopilot,
  planRank,
  pricing,
  REFERRAL_REWARD,
  type PlanId,
} from "@/config/pricing";
import type { ReferralAdminFlag, ReferralCredit, Workspace } from "@/db/schema";
import { appUrl } from "@/lib/app-url";
import { planFromLookupKey } from "./billing-rules";
import { effectiveStatus, SENDING_ALLOWED, setupReallyPaid } from "./lifecycle";
import { isReferralCode } from "@/lib/referral-code";
import { PUBLIC_WEBMAIL_DOMAINS } from "./sender-rules";

/**
 * Plan #47 referrals — pure rules. Offer A (Davi, 2026-10-15): when someone you referred has
 * paid and is active, your next month is free on the plan above yours (Solo → Crew, Crew →
 * Company, Company → Company), then you go back to your own plan unless you tap Keep. Stripe
 * keeps billing the plan the owner pays for; a one-time 100%-off coupon makes the next renewal's
 * plan line free, and the app grants the plan above for exactly that line's period.
 * Everything is off unless FEATURE_REFERRALS is on AND REFERRAL_REWARD is set.
 */

/** Owners on these share a domain with strangers, so the same-domain block doesn't apply. */
export { PUBLIC_WEBMAIL_DOMAINS };

/** 12 characters of base64url: 9 random bytes, nothing about the owner in it. */
export { isReferralCode };

export function newReferralCode(): string {
  return randomBytes(9).toString("base64url");
}

/** The link an owner shares: the app's home page with their code, and nothing else. */
export function referralLink(
  code: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return `${appUrl("/", env)}?ref=${encodeURIComponent(code)}`;
}

/**
 * A Postgres unique violation (23505), from the driver directly or wrapped by Drizzle. Only
 * this may be retried when making a code; anything else (a dropped connection) is rethrown.
 */
export function isUniqueViolation(err: unknown): boolean {
  for (let e = err as { code?: unknown; cause?: unknown } | null, i = 0; e && i < 5; i++) {
    if (e.code === "23505") return true;
    e = e.cause as typeof e;
  }
  return false;
}

type Party = { workspaceId: string; ownerEmail: string };

function domainOf(email: string): string {
  return email.trim().toLowerCase().split("@").pop() ?? "";
}

/**
 * Why a referral can't count, or null if it can. Referring yourself (same workspace or same
 * owner email) never counts; nor do two owners at the same business domain (a@shop.com and
 * b@shop.com) — but two unrelated gmail.com owners are fine.
 */
export function referralRefusal(referrer: Party, referred: Party): "self" | "same_domain" | null {
  if (referrer.workspaceId === referred.workspaceId) return "self";
  const a = referrer.ownerEmail.trim().toLowerCase();
  const b = referred.ownerEmail.trim().toLowerCase();
  if (a === b) return "self";
  const da = domainOf(a);
  if (da && da === domainOf(b) && !PUBLIC_WEBMAIL_DOMAINS.has(da)) return "same_domain";
  return null;
}

// --- What a referral earns ------------------------------------------------------------------

/** The offer configured in src/config/pricing.ts. */
export type ReferralOffer = NonNullable<typeof REFERRAL_REWARD>;
type ReferralConfig = { reward: ReferralOffer | null };

let testConfig: ReferralConfig | undefined;

/** Tests only: stand in for REFERRAL_REWARD. Pass undefined to reset. */
export function setReferralConfigForTests(config: ReferralConfig | undefined) {
  testConfig = config;
}

/**
 * What a referral earns right now, or null when it earns nothing: the switch is off, or no
 * reward is configured. Only the referrer is rewarded (Davi, 2026-10-13).
 */
export function referralReward(
  env: Record<string, string | undefined> = process.env,
  reward: ReferralOffer | null = testConfig ? testConfig.reward : REFERRAL_REWARD,
): { kind: ReferralOffer } | null {
  if (!featureOn("referrals", env)) return null;
  if (reward !== "free_month_one_plan_up") return null;
  return { kind: reward };
}

/** Whether anything about referrals shows or is recorded at all. */
export function referralsVisible(env: Record<string, string | undefined> = process.env): boolean {
  return referralReward(env) !== null;
}

/**
 * The durable "who was referred" key (A5): sha256 of the normalized email, salted with
 * AUTH_SECRET like the waitlist IP hash, so the raw address isn't kept after deletion.
 */
export function referredEmailHash(
  email: string,
  salt: string = process.env.AUTH_SECRET ?? "",
): string {
  return createHash("sha256")
    .update(`${salt}:referral:${email.trim().toLowerCase()}`)
    .digest("hex");
}

/** A Stripe error code is a fixed snake_case word; anything else is stored as the error's name. */
export function errorCodeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[a-z_]{1,64}$/.test(code)) return code;
  return err instanceof Error ? err.name.slice(0, 64) : "unknown";
}

// --- The plan that counts -------------------------------------------------------------------

type PlanFields = Pick<Workspace, "plan" | "freePlan" | "freePlanUntil">;

/** A free month is running: a free plan is set and its end is still ahead. */
export function freeMonthRunning(w: PlanFields, now: Date = new Date()): boolean {
  return !!w.freePlan && !!w.freePlanUntil && w.freePlanUntil.getTime() > now.getTime();
}

/**
 * The plan features read: the free plan while a free month runs and it is above the billed
 * plan, else the billed plan. Bounded by time, so features drop at the end even if no job runs;
 * it can only ever raise the plan, never lower it.
 */
export function effectivePlan(w: PlanFields, now: Date = new Date()): PlanId | null {
  if (freeMonthRunning(w, now) && planRank(w.freePlan) > planRank(w.plan)) return w.freePlan;
  return w.plan;
}

// --- Stripe shapes (API 2026-09-30, stripe@23) ----------------------------------------------

type AnyDiscount = string | Stripe.Discount | Stripe.DeletedDiscount;

/** Our coupons' ids start with this; customers can't type coupon ids (only promotion codes). */
export const REFERRAL_COUPON_PREFIX = "sa_ref_";

/** One coupon per reward row, with a deterministic id (a retry finds it already made). */
export const referralCouponId = (rewardId: string) => `${REFERRAL_COUPON_PREFIX}${rewardId}`;

/** What Stripe's invoice and receipt show. Names no plan: plans can change before it's used. */
export const REFERRAL_COUPON_NAME = "Referral thanks: this month is free";

/** Stripe allows at most this many discounts on one subscription. */
export const MAX_SUBSCRIPTION_DISCOUNTS = 20;

export const idOf = (d: AnyDiscount): string => (typeof d === "string" ? d : d.id);

/** The coupon behind a discount (`discount.source.coupon`), or null when not expanded. */
export function couponOf(d: AnyDiscount): string | null {
  if (typeof d === "string") return null;
  const c = d.source?.coupon;
  return c == null ? null : typeof c === "string" ? c : c.id;
}

export const isReferralDiscount = (d: AnyDiscount): boolean =>
  couponOf(d)?.startsWith(REFERRAL_COUPON_PREFIX) ?? false;

const idOrNull = (v: string | { id: string } | null | undefined): string | null =>
  v == null ? null : typeof v === "string" ? v : v.id;

/** The subscription an invoice belongs to. */
export function invoiceSubscriptionId(inv: Pick<Stripe.Invoice, "parent">): string | null {
  return idOrNull(inv.parent?.subscription_details?.subscription);
}

/** The invoice used this discount (its top-level list, its totals, or a line's amounts). */
export function invoiceUsed(
  inv: Pick<Stripe.Invoice, "discounts" | "total_discount_amounts" | "lines">,
  discountId: string,
): boolean {
  if (inv.discounts?.some((d) => idOf(d) === discountId)) return true;
  if (inv.total_discount_amounts?.some((a) => idOf(a.discount) === discountId)) return true;
  return (
    inv.lines?.data?.some((l) =>
      l.discount_amounts?.some((a) => idOf(a.discount) === discountId),
    ) ?? false
  );
}

/** The plan line: the subscription item's own line (not a proration) for this subscription. */
export function planLine(
  lines: Stripe.InvoiceLineItem[],
  subId: string,
): Stripe.InvoiceLineItem | null {
  return (
    lines.find((l) => {
      const d = l.parent?.subscription_item_details;
      if (l.parent?.type !== "subscription_item_details" || !d || d.proration) return false;
      return (d.subscription ?? idOrNull(l.subscription)) === subId;
    }) ?? null
  );
}

/** The price billed on an invoice line (an id; Stripe doesn't expand it by default). */
export function linePriceId(line: Pick<Stripe.InvoiceLineItem, "pricing">): string | null {
  return idOrNull(line.pricing?.price_details?.price);
}

/** How much of a line this discount took off. */
export function lineDiscountedBy(
  line: Pick<Stripe.InvoiceLineItem, "discount_amounts">,
  discountId: string,
): number {
  return (line.discount_amounts ?? [])
    .filter((a) => idOf(a.discount) === discountId)
    .reduce((sum, a) => sum + a.amount, 0);
}

/** The discount made the plan line free (never "the invoice is $0": prorations can stay). */
export function planLineFullyFree(
  line: Pick<Stripe.InvoiceLineItem, "amount" | "discount_amounts">,
  discountId: string,
): boolean {
  return lineDiscountedBy(line, discountId) >= line.amount;
}

/**
 * Pending charges to remove while a free month runs: positive prorations for this subscription
 * whose period overlaps [start, end). Credits are left alone ($0 or in the owner's favour), and
 * nothing already on an invoice is touched.
 */
export function chargesForFreeDays(
  items: Stripe.InvoiceItem[],
  subId: string,
  start: Date,
  end: Date,
): string[] {
  const s = Math.floor(start.getTime() / 1000);
  const e = Math.floor(end.getTime() / 1000);
  return items
    .filter(
      (i) =>
        i.proration &&
        i.amount > 0 &&
        i.invoice == null &&
        i.parent?.subscription_details?.subscription === subId &&
        i.period.start < e &&
        i.period.end > s,
    )
    .map((i) => i.id);
}

/**
 * Stripe's billing page schedules downgrades for the period end ("Manage downgrades"), which
 * makes a subscription schedule whose next phase can drop our discount. Free months wait while
 * it does.
 */
export function portalSchedulesDowngrades(
  config: Pick<Stripe.BillingPortal.Configuration, "features">,
): boolean {
  const update = config.features?.subscription_update;
  return !!update?.enabled && (update.schedule_at_period_end?.conditions?.length ?? 0) > 0;
}

// --- When a free month may be booked --------------------------------------------------------

/** Why a waiting free month can't be booked on the subscription yet. Empty = book it. */
export type AttachWait =
  | "reward_off"
  | "other_mode"
  | "account_off"
  | "no_subscription"
  | "subscription_not_active"
  | "set_to_end"
  | "schedule"
  | "not_one_item"
  | "unknown_price"
  | "discounts_unreadable"
  | "referral_discount_on"
  | "too_many_discounts"
  | "another_free_month"
  | "portal_schedules_downgrades";

export type AttachContext = {
  /** `referralReward() !== null`: only new attaches stop when it's off. */
  rewardOn: boolean;
  /** The row's `stripe_mode` and the key's: a test-mode reward never touches a live subscription. */
  rowMode: "live" | "test" | null;
  keyMode: "live" | "test" | null;
  /** Another reward of this workspace is scheduled or running (one at a time). */
  otherFreeMonth: boolean;
  /** From the default portal configuration; null = couldn't be read (nothing attaches). */
  portalSchedulesDowngrades: boolean | null;
};

type AttachSub = Pick<
  Stripe.Subscription,
  "status" | "cancel_at_period_end" | "cancel_at" | "schedule" | "items" | "discounts"
>;

/**
 * Whether a pending reward may be put on the subscription now. One rule for the account: a free
 * month only starts while the account is on (setup_paid or active, set up through Stripe).
 */
export function canAttach(
  w: Pick<Workspace, "status" | "evaluationEndsAt" | "setupPaidVia">,
  sub: AttachSub | null,
  ctx: AttachContext,
  now: Date = new Date(),
): AttachWait[] {
  const out: AttachWait[] = [];
  if (!ctx.rewardOn) out.push("reward_off");
  if (!ctx.keyMode || ctx.rowMode !== ctx.keyMode) out.push("other_mode");
  if (!SENDING_ALLOWED.includes(effectiveStatus(w, now)) || w.setupPaidVia !== "stripe")
    out.push("account_off");
  if (ctx.otherFreeMonth) out.push("another_free_month");
  if (ctx.portalSchedulesDowngrades !== false) out.push("portal_schedules_downgrades");
  if (!sub) {
    out.push("no_subscription");
    return out;
  }
  if (sub.status !== "active") out.push("subscription_not_active");
  if (sub.cancel_at_period_end || sub.cancel_at != null) out.push("set_to_end");
  if (sub.schedule != null) out.push("schedule");
  const items = sub.items?.data ?? [];
  if (items.length !== 1) out.push("not_one_item");
  else if (!planFromLookupKey(items[0]!.price?.lookup_key)) out.push("unknown_price");
  const discounts = sub.discounts ?? [];
  if (discounts.some((d) => typeof d === "string")) out.push("discounts_unreadable");
  if (discounts.some(isReferralDiscount)) out.push("referral_discount_on");
  if (discounts.length >= MAX_SUBSCRIPTION_DISCOUNTS) out.push("too_many_discounts");
  return out;
}

// --- Keep / Go back -------------------------------------------------------------------------

/** Keep and Go back close this long before the free month ends (Stripe's renewal is near). */
export const KEEP_CUTOFF_MS = 60 * 60_000;

type OfferWorkspace = Pick<
  Workspace,
  "status" | "evaluationEndsAt" | "setupPaidVia" | "plan" | "stripeCancelAt"
>;
type OfferReward = Pick<
  ReferralCredit,
  "status" | "endsAt" | "freePlan" | "paidPlan" | "paidPriceId" | "paidPriceCents"
>;

function offerOpen(
  w: OfferWorkspace,
  r: OfferReward,
  now: Date,
): r is OfferReward & {
  endsAt: Date;
  freePlan: PlanId;
} {
  if (r.status !== "running" || !r.endsAt || !r.freePlan) return false;
  if (now.getTime() >= r.endsAt.getTime() - KEEP_CUTOFF_MS) return false;
  if (!SENDING_ALLOWED.includes(effectiveStatus(w, now)) || !setupReallyPaid(w)) return false;
  return w.stripeCancelAt == null;
}

/**
 * "Keep Crew": offered while the free plan is above the billed one (never Company → Company,
 * never after a Keep). The price is today's config price, which the owner confirms.
 */
export function keepOffer(
  w: OfferWorkspace,
  r: OfferReward,
  now: Date = new Date(),
): { plan: PlanId; priceCents: number; firstChargeAt: Date } | null {
  if (!offerOpen(w, r, now)) return null;
  if (planRank(r.freePlan) <= planRank(w.plan)) return null;
  return {
    plan: r.freePlan,
    priceCents: pricing.plans[r.freePlan].amountCents,
    firstChargeAt: r.endsAt,
  };
}

/** "Go back to Solo": only after a Keep, back to exactly the price they paid before. */
export function goBackOffer(
  w: OfferWorkspace,
  r: OfferReward,
  now: Date = new Date(),
): { plan: PlanId; priceCents: number; at: Date } | null {
  if (!offerOpen(w, r, now)) return null;
  if (!r.paidPlan || !r.paidPriceId || r.paidPriceCents == null) return null;
  if (w.plan !== r.freePlan || r.freePlan === r.paidPlan) return null;
  return { plan: r.paidPlan, priceCents: r.paidPriceCents, at: r.endsAt };
}

// --- Stripe errors, per operation -----------------------------------------------------------

export type ReferralStripeOp =
  "coupon_create" | "attach" | "detach" | "strip" | "plan_change" | "invoice_item_delete";

/**
 * ok = the result we wanted (already there / already gone); transient = try again later;
 * recheck = read the subscription again and decide; permanent = this reward can't go on.
 */
export type StripeErrorClass = "ok" | "transient" | "recheck" | "permanent";

function errorParts(err: unknown) {
  const e = (err ?? {}) as { type?: unknown; code?: unknown; statusCode?: unknown };
  return {
    type: typeof e.type === "string" ? e.type : "",
    code: typeof e.code === "string" ? e.code : "",
    status: typeof e.statusCode === "number" ? e.statusCode : 0,
  };
}

const isInvalidRequest = (type: string) =>
  type === "StripeInvalidRequestError" || type === "invalid_request_error";

/** A 4xx answer: Stripe heard us and said no (not a rate limit, which is worth waiting out). */
function isClientError(err: unknown): boolean {
  const { type, status } = errorParts(err);
  if (type === "StripeRateLimitError" || status === 429) return false;
  if (isInvalidRequest(type) || type === "StripeIdempotencyError" || type === "idempotency_error")
    return true;
  return status >= 400 && status < 500;
}

export function classifyStripeError(op: ReferralStripeOp, err: unknown): StripeErrorClass {
  const { type, code } = errorParts(err);
  switch (op) {
    case "coupon_create":
      if (code === "resource_already_exists") return "ok";
      return isInvalidRequest(type) ? "permanent" : "transient";
    case "attach":
    case "detach":
    case "strip":
    case "plan_change":
      return isClientError(err) ? "recheck" : "transient";
    case "invoice_item_delete":
      return code === "resource_missing" ? "ok" : "transient";
  }
}

// --- What changes when a free month ends ----------------------------------------------------

export type EndChanges = {
  /** The plan the account goes back to. */
  to: PlanId | null;
  /** Inboxes that plan includes. */
  limit: number;
  /** Inboxes counted against the limit now (active or needing a reconnect). */
  counted: number;
  /** How many of them pause at the end. */
  inboxesPause: number;
  /** A category is on autopilot and the plan it goes back to has none. */
  autopilotTurnsOff: boolean;
};

/** What will actually change at the end, from live counts (never a guess). */
export function endChanges(x: {
  to: PlanId | null;
  countedInboxes: number;
  autopilotCategoriesOn: number;
}): EndChanges {
  const limit = mailboxLimitFor(x.to);
  return {
    to: x.to,
    limit,
    counted: x.countedInboxes,
    inboxesPause: Math.max(0, x.countedInboxes - limit),
    autopilotTurnsOff: x.autopilotCategoriesOn > 0 && !planHasAutopilot(x.to),
  };
}

// --- Copy (plain words; dates in the owner's time zone) -------------------------------------

const DEFAULT_ZONE = "America/New_York";

/** "Nov 15" in the owner's time zone (Eastern when the zone is missing or invalid). */
export function shortDate(d: Date, timeZone: string | null | undefined = DEFAULT_ZONE): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: timeZone || DEFAULT_ZONE }).format(
      d,
    );
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: DEFAULT_ZONE }).format(d);
  }
}

const planName = (p: PlanId) => pricing.plans[p].name;
const inboxes = (n: number) => `${n} inbox${n === 1 ? "" : "es"}`;
const addresses = (n: number) => `${n} Gmail address${n === 1 ? "" : "es"}`;

/** "Solo includes 1 inbox" (or the no-plan allowance). */
export function planIncludes(plan: PlanId | null): string {
  return plan
    ? `${planName(plan)} includes ${inboxes(mailboxLimitFor(plan))}`
    : `Before you choose a plan, you get ${inboxes(mailboxLimitFor(null))}`;
}

/** The plan to move up to for more inboxes, or null at the top. */
function planForMore(plan: PlanId | null): PlanId | null {
  const up = plan ? planAbove(plan) : "solo";
  return up !== plan && mailboxLimitFor(up) > mailboxLimitFor(plan) ? up : null;
}

/** §4.1 The "Share Squared Away" card on Plan & billing. */
export function shareCardCopy(
  w: { plan: PlanId | null; status: Workspace["status"] },
  earnThreshold: number,
): { title: string; intro: string; plan: string; setup: string | null; after: string } {
  const intro =
    "Know another contractor who'd like this? Send them your link. Once they've paid and had their setup call, your next month is free, on the plan above yours.";
  const after =
    "After the free month you go back to your own plan by itself. We never charge you more unless you tap Keep. One free month at a time, one per new business. They need to join the waitlist from your link, or it won't count.";
  let plan: string;
  let setup: string | null = null;
  switch (w.plan) {
    case "solo":
      plan = `You're on Solo, so that's a free month of Crew: up to ${inboxes(mailboxLimitFor("crew"))}, and autopilot for the kinds of email you've okayed ${earnThreshold} times.`;
      if (w.status === "setup_paid") setup = "Autopilot starts once your setup call is done.";
      break;
    case "crew":
      // Davi, 2026-10-16 (Q4): a free Company month includes priority support.
      plan = `You're on Crew, so that's a free month of Company: up to ${inboxes(mailboxLimitFor("company"))} and priority support.`;
      break;
    case "company":
      plan = "You're on Company, so that's a month of Company free.";
      break;
    default:
      plan = "Once you're on a plan, it's a free month of the plan above yours.";
  }
  return { title: "Share Squared Away", intro, plan, setup, after };
}

export type RewardStatusInput = {
  reward: { status: "pending" | "scheduled"; startsAt: Date | null };
  workspace: Pick<
    Workspace,
    "status" | "evaluationEndsAt" | "plan" | "stripeSubscriptionId" | "stripeCancelAt"
  >;
  /** Another free month of this workspace is booked or running. */
  anotherFreeMonth: boolean;
  timeZone?: string | null;
  now?: Date;
};

/** §4.2 The line under the share card for an earned month that hasn't started. */
export function rewardStatusLine(x: RewardStatusInput): string {
  const { reward, workspace: w, timeZone } = x;
  const now = x.now ?? new Date();
  if (w.stripeCancelAt)
    return `Your plan is set to end on ${shortDate(w.stripeCancelAt, timeZone)}, so your free month waits. Turn renewal back on in Manage billing to use it.`;
  if (reward.status === "scheduled") {
    const up = w.plan ? planName(planAbove(w.plan)) : "the plan above yours";
    const when = reward.startsAt
      ? `It starts ${shortDate(reward.startsAt, timeZone)}, when your plan renews.`
      : "It starts when your plan renews.";
    return `Thanks for the referral. Your next month is free, on ${up}. ${when}`;
  }
  if (x.anotherFreeMonth)
    return "You've earned another free month. It starts at a renewal after this one ends.";
  const status = effectiveStatus(w, now);
  if (status === "past_due")
    return "You've earned a free month. It starts once your payment goes through.";
  if (status === "paused")
    return "You've earned a free month. It starts once your account is back on.";
  if (status === "canceled")
    return "You've earned a free month. It waits for you if you start your plan again.";
  if (!w.stripeSubscriptionId || !SENDING_ALLOWED.includes(status))
    return "You've earned a free month. It starts at your first renewal once you're on a plan.";
  return "You've earned a free month. We're setting it up now.";
}

/** "2 inboxes pause" / "autopilot turns off", for the end-of-month lines. */
function changeParts(c: EndChanges | null): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (c.inboxesPause > 0)
    out.push(`${inboxes(c.inboxesPause)} ${c.inboxesPause === 1 ? "pauses" : "pause"}`);
  if (c.autopilotTurnsOff) out.push("autopilot turns off");
  return out;
}

/** The banner adds what will change from this long before the end. */
export const END_WARNING_MS = 3 * 86_400_000;

export type FreeMonthBanner = { line: string; link: { label: string; href: string } | null };

/**
 * §4.3 The banner on every signed-in screen while a free month runs (bordered, not inverted).
 * Only for an account that is on: past due, paused, canceled and unpaid-setup banners win.
 */
export function freeMonthBanner(x: {
  workspace: Pick<
    Workspace,
    | "status"
    | "evaluationEndsAt"
    | "setupPaidVia"
    | "plan"
    | "freePlan"
    | "freePlanUntil"
    | "stripeCancelAt"
  >;
  reward: Pick<ReferralCredit, "paidPlan" | "keptPriceCents"> | null;
  changes: EndChanges | null;
  timeZone?: string | null;
  now?: Date;
}): FreeMonthBanner | null {
  const { workspace: w, reward, timeZone } = x;
  const now = x.now ?? new Date();
  if (!freeMonthRunning(w, now) || !w.freePlan || !w.freePlanUntil) return null;
  if (!SENDING_ALLOWED.includes(effectiveStatus(w, now)) || !setupReallyPaid(w)) return null;
  const free = w.freePlan;
  const until = shortDate(w.freePlanUntil, timeZone);
  if (w.stripeCancelAt)
    return {
      line: `You're on ${planName(free)} free until ${until}. Your plan is set to end on ${shortDate(w.stripeCancelAt, timeZone)}.`,
      link: null,
    };
  if (w.plan && planRank(free) > planRank(w.plan)) {
    const soon = w.freePlanUntil.getTime() - now.getTime() <= END_WARNING_MS;
    const parts = soon ? changeParts(x.changes) : [];
    const canKeep = now.getTime() < w.freePlanUntil.getTime() - KEEP_CUTOFF_MS;
    return {
      line: `You're on ${planName(free)} free until ${until} — then back to ${planName(w.plan)}${parts.length ? `: ${parts.join(" and ")}` : ""}.`,
      link: canKeep ? { label: `Keep ${planName(free)}?`, href: "/billing#free-month" } : null,
    };
  }
  if (w.plan === free && reward?.paidPlan && reward.paidPlan !== free) {
    const price = reward.keptPriceCents ?? pricing.plans[free].amountCents;
    return {
      line: `You're on ${planName(free)} free until ${until}. Then ${planName(free)} is ${formatDollars(price)} a month.`,
      link: null,
    };
  }
  return {
    line: w.plan
      ? `This month's free, thanks for the referral. ${planName(w.plan)} renews ${until}.`
      : "This month's free, thanks for the referral.",
    link: null,
  };
}

/** §4.4 Under the billed plan on Plan & billing during a free month. */
export function billedPlanFreeLine(free: PlanId, until: Date, timeZone?: string | null): string {
  return `${planName(free)} is free until ${shortDate(until, timeZone)}, our thanks for the referral.`;
}

/** §4.4 Next to Manage billing: Stripe's page shows the billed plan. */
export function stripePageShowsLine(billed: PlanId): string {
  return `Stripe's page shows ${planName(billed)}, the plan you pay for.`;
}

/** §4.4 Next to Manage billing while a free month runs (Q3: plan changes wait). */
export function planChangesWaitLine(
  until: Date,
  timeZone?: string | null,
  keepOnOffer = true,
): string {
  return `Plan changes wait until your free month ends on ${shortDate(until, timeZone)}. ${keepOnOffer ? "Use Keep above, or update" : "You can update"} your card or cancel on Stripe's page.`;
}

/** §4.4 "Your free month": what happens at the end, from live counts. */
export function freeMonthSummary(x: {
  free: PlanId;
  until: Date;
  backTo: PlanId;
  backToPriceCents: number;
  changes: EndChanges | null;
  timeZone?: string | null;
}): string[] {
  const limit = mailboxLimitFor(x.backTo);
  const lines = [
    `You're on ${planName(x.free)} free until ${shortDate(x.until, x.timeZone)}. Then you go back to ${planName(x.backTo)} at ${formatDollars(x.backToPriceCents)} a month${limit > 1 ? `: up to ${inboxes(limit)}` : ""}.`,
  ];
  lines.push(...endChangeLines(x.changes));
  return lines;
}

/** "Autopilot turns off then." / "2 of your 3 inboxes pause then; nothing is deleted." */
export function endChangeLines(c: EndChanges | null): string[] {
  if (!c) return [];
  const lines: string[] = [];
  if (c.autopilotTurnsOff) lines.push("Autopilot turns off then.");
  if (c.inboxesPause > 0)
    lines.push(
      `${c.inboxesPause} of your ${inboxes(c.counted)} ${c.inboxesPause === 1 ? "pauses" : "pause"} then; nothing is deleted.`,
    );
  return lines;
}

/** §4.4 The Keep button and its confirm (the price that will be charged, named in full). */
export function keepCopy(x: {
  free: PlanId;
  priceCents: number;
  paidPriceCents: number | null;
  firstChargeAt: Date;
  timeZone?: string | null;
}) {
  const name = planName(x.free);
  const price = formatDollars(x.priceCents);
  const date = shortDate(x.firstChargeAt, x.timeZone);
  const more =
    x.paidPriceCents != null && x.priceCents > x.paidPriceCents
      ? ` That's ${formatDollars(x.priceCents - x.paidPriceCents)} more than you pay now.`
      : "";
  return {
    button: `Keep ${name}`,
    title: `Keep ${name} after ${date}?`,
    body: `${name} is ${price} a month, plus sales tax where it applies.${more} Your first ${name} payment is on ${date}. Nothing is charged today.`,
    yes: `Yes, keep ${name} at ${price} a month`,
    no: "Not now",
    notice: `Kept. ${name} from ${date}, at ${price} a month.`,
  };
}

/** §4.4 After a Keep: going back to the plan (and price) they paid before. */
export function goBackCopy(x: {
  backTo: PlanId;
  paidPriceCents: number;
  at: Date;
  changes: EndChanges | null;
  timeZone?: string | null;
}) {
  const name = planName(x.backTo);
  const date = shortDate(x.at, x.timeZone);
  return {
    prompt: "Changed your mind?",
    button: `Go back to ${name} after ${date}`,
    title: `Go back to ${name} after ${date}?`,
    body: [
      `You'll pay ${formatDollars(x.paidPriceCents)} a month again, as before.`,
      ...endChangeLines(x.changes),
    ],
    yes: `Yes, go back to ${name}`,
    no: "Not now",
    notice: `Done. Back to ${name} after ${date}.`,
  };
}

/**
 * §4.5 Settings → Your Gmail, under a Gmail address paused for being over the plan (the
 * decisions package's card says why and offers "Use this one instead"): the way up a plan.
 */
export function pausedInboxCopy(plan: PlanId | null) {
  const more = planForMore(plan);
  return { more: more ? `Or move to ${planName(more)} in Plan & billing.` : null };
}

/** §4.5 "Add another inbox" during a free month, with the paid plan's inboxes already in use. */
export function addInboxFreeMonthNote(free: PlanId, until: Date, timeZone?: string | null): string {
  return `This inbox pauses on ${shortDate(until, timeZone)} unless you keep ${planName(free)}. Nothing is deleted.`;
}

/** §4.5 Settings → Autopilot during a free month whose plan adds autopilot. */
export function autopilotFreeMonthLine(
  free: PlanId,
  until: Date,
  timeZone?: string | null,
): string {
  return `Autopilot is part of your free ${planName(free)} month until ${shortDate(until, timeZone)}.`;
}

// --- Activity (§4.7): short, no trailing period; details hold plan ids, dates, prices, counts --

const planOf = (v: unknown): string | null =>
  typeof v === "string" && Object.hasOwn(pricing.plans, v) ? planName(v as PlanId) : null;
const countOf = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
const centsOf = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
function dateOf(v: unknown, timeZone?: string | null): string | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : shortDate(d, timeZone);
}

/** The Activity line for a free-month or plan-effect row, or null when it isn't one of ours. */
export function referralActivityLine(
  action: string,
  detail: Record<string, unknown>,
  timeZone?: string | null,
): string | null {
  switch (action) {
    case "referral_reward_earned":
      return "Someone you referred is all set up. You earned a free month";
    case "referral_free_month_scheduled": {
      const when = dateOf(detail.startsAt, timeZone);
      return when
        ? `Your free month starts ${when}, on the plan above yours`
        : "Your free month is booked, on the plan above yours";
    }
    case "referral_free_month_started": {
      const plan = planOf(detail.plan);
      const until = dateOf(detail.endsAt, timeZone);
      if (!plan) return "Your free month started";
      if (detail.paidPlan === detail.plan)
        return until
          ? `Your free month started. ${plan} is free until ${until}`
          : `Your free month started. ${plan} is free this month`;
      return until
        ? `Your free month of ${plan} started. It runs until ${until}`
        : `Your free month of ${plan} started`;
    }
    case "referral_plan_kept": {
      const plan = planOf(detail.plan);
      const cents = centsOf(detail.priceCents);
      const from = dateOf(detail.firstChargeAt, timeZone);
      if (!plan) return "You chose to keep your free month's plan";
      return `You chose to keep ${plan}${cents != null ? `: ${formatDollars(cents)} a month` : ""}${from ? ` from ${from}` : ""}`;
    }
    case "referral_keep_undone": {
      const plan = planOf(detail.plan);
      const at = dateOf(detail.at, timeZone);
      if (!plan) return "You chose to go back to your own plan";
      return `You chose to go back to ${plan}${at ? ` after ${at}` : ""}`;
    }
    case "referral_free_month_ended": {
      const plan = planOf(detail.plan);
      const back = planOf(detail.backTo);
      if (!plan) return "Your free month ended";
      return back && back !== plan
        ? `Your free month of ${plan} ended. You're back on ${back}`
        : `Your free month of ${plan} ended`;
    }
    case "referral_reward_returned":
      switch (detail.why) {
        case "plan_ended":
          return "Your plan ended before your free month began. It'll wait for you";
        case "account_off":
          return "Your free month waits until your account is back on";
        case "renewed_without":
          return "Stripe renewed without your free month, so it moves to your next renewal";
        case "discount_removed":
          return "Your free month came off your plan in Stripe before it began, so it moves to your next renewal";
        default:
          return "Your free month waits for a later renewal";
      }
    case "autopilot_turned_off_plan":
      return "Autopilot is off again. It comes with Crew and Company";
    // The plan pause (decisions 2026-10-16, `mailbox-plan.ts`), which plan #47's free months
    // drive too: a free month ending or a move down pauses addresses, Keep or more room resumes.
    case "mailboxes_fit_plan": {
      const paused = countOf(detail.paused);
      const resumed = countOf(detail.resumed);
      const limit = countOf(detail.limit);
      if (paused)
        return limit
          ? `Paused ${addresses(paused)}. Your plan covers ${addresses(limit)}. Nothing was deleted`
          : `Paused ${addresses(paused)} over your plan. Nothing was deleted`;
      if (resumed) return `Switched ${addresses(resumed)} back on`;
      return null;
    }
    case "mailbox_plan_swap":
      return "You switched which Gmail address is on";
    default:
      return null;
  }
}

// --- /admin (§4.8): counts, dates, plan names and fixed codes only --------------------------

/** What a flag means, for /admin (Davi's to-do, never shown to the owner). */
export const REFERRAL_FLAG_TEXT: Record<ReferralAdminFlag, string> = {
  renewed_without_discount: "Stripe renewed without the free month: check",
  discount_removed: "discount removed in Stripe",
  plan_changed_in_free_month: "plan changed in Stripe during a free month: check",
  free_day_charges_removed: "charges for days of a free month removed",
  second_month_given: "the next renewal was free too (the coupon stayed on): bill it by hand",
  free_invoice_lost_discount:
    "the free month's invoice is still a draft and lost its discount: check before it's paid",
  charged_for_free_days: "charged for free days: credit by hand",
  invoice_not_final: "free-month invoice never finalized: check",
  discount_lingered: "used discount stayed on: removed",
  unknown_price: "price made by hand",
  not_fully_free: "plan line wasn't fully free: check",
};

/** After this many failed tries in total, /admin says Stripe keeps refusing. */
export const ADMIN_REFUSED_AFTER = 3;

export type AdminRewardRow = Pick<
  ReferralCredit,
  | "status"
  | "stripeMode"
  | "startsAt"
  | "endsAt"
  | "freePlan"
  | "keptAt"
  | "attempts"
  | "lastErrorCode"
  | "adminFlag"
  | "flaggedAt"
>;

/** Why the first waiting free month waits, from the database (no Stripe call). */
function waitReason(
  w: Pick<Workspace, "status" | "evaluationEndsAt" | "setupPaidVia" | "stripeSubscriptionId">,
  row: AdminRewardRow,
  keyMode: "live" | "test" | null,
  otherFreeMonth: boolean,
  now: Date,
): string {
  if (row.stripeMode && row.stripeMode !== keyMode) return `earned in ${row.stripeMode} mode`;
  if (otherFreeMonth) return "after the current free month";
  if (!w.stripeSubscriptionId) return "no plan yet";
  if (!SENDING_ALLOWED.includes(effectiveStatus(w, now)) || w.setupPaidVia !== "stripe")
    return "account off";
  return "being set up";
}

/** The "Free months" lines on an /admin account card (empty when there's nothing to say). */
export function adminFreeMonthLines(
  w: Pick<Workspace, "status" | "evaluationEndsAt" | "setupPaidVia" | "stripeSubscriptionId">,
  rows: AdminRewardRow[],
  keyMode: "live" | "test" | null,
  now: Date = new Date(),
): string[] {
  const zone = DEFAULT_ZONE;
  const lines: string[] = [];
  const running = rows.find((r) => r.status === "running");
  const scheduled = rows.find((r) => r.status === "scheduled");
  const pending = rows.filter((r) => r.status === "pending");
  if (running && running.freePlan && running.endsAt)
    lines.push(
      `${planName(running.freePlan)} until ${shortDate(running.endsAt, zone)}${running.keptAt ? " · kept" : ""}`,
    );
  if (scheduled)
    lines.push(
      scheduled.startsAt ? `next from ${shortDate(scheduled.startsAt, zone)}` : "next booked",
    );
  if (pending.length) {
    const reason = waitReason(w, pending[0]!, keyMode, !!(running || scheduled), now);
    lines.push(`${pending.length} waiting (${reason})`);
    const refused = pending.find((r) => r.attempts >= ADMIN_REFUSED_AFTER && r.lastErrorCode);
    if (refused)
      lines.push(`Stripe refused to add it ${refused.attempts} times (${refused.lastErrorCode})`);
  }
  for (const r of rows.filter((x) => x.status === "failed"))
    lines.push(
      r.lastErrorCode === "used_early"
        ? "used early: check in Stripe"
        : r.lastErrorCode === "coupon_refused"
          ? "Stripe refused the coupon: check in Stripe"
          : `failed (${r.lastErrorCode ?? "unknown"})`,
    );
  const flagged = rows
    .filter((r) => r.adminFlag)
    .sort((a, b) => (b.flaggedAt?.getTime() ?? 0) - (a.flaggedAt?.getTime() ?? 0))[0];
  if (flagged?.adminFlag) lines.push(REFERRAL_FLAG_TEXT[flagged.adminFlag]);
  return lines;
}

/** /admin's plan stat: the billed plan, plus the free one while it runs. */
export function adminPlanLabel(
  w: Pick<Workspace, "plan" | "freePlan" | "freePlanUntil">,
  now: Date = new Date(),
): string {
  const billed = w.plan ? planName(w.plan) : "None yet";
  if (!freeMonthRunning(w, now) || !w.freePlan || !w.freePlanUntil) return billed;
  if (w.freePlan === w.plan)
    return `${billed}, free to ${shortDate(w.freePlanUntil, DEFAULT_ZONE)}`;
  return `${billed}, ${planName(w.freePlan)} free to ${shortDate(w.freePlanUntil, DEFAULT_ZONE)}`;
}

/** /admin Payments (§1.8): free months wait while Stripe's page schedules downgrades. */
export const PORTAL_SCHEDULES_DOWNGRADES_LINE =
  "Stripe's billing page schedules downgrades at period end, so free months wait. Turn that off in Stripe → Customer portal.";

/**
 * /admin Payments: the positive check docs/SETUP.md §6d step 2 asks for before referrals go on.
 * A failed read says so, so silence never passes for "all clear".
 */
export const PORTAL_DOWNGRADES_NOW_LINE =
  "Stripe's billing page changes plans straight away, so free months can be booked.";
export const PORTAL_UNKNOWN_LINE =
  "Couldn't check Stripe's billing page settings just now. Refresh before turning referrals on.";

/**
 * /admin Payments (§1.8.2), information only: customers can reach the default billing page
 * (plan changes included) from Stripe's hosted login page, even during a free month. The
 * backstop removes any charge for the free days.
 */
export const PORTAL_LOGIN_PAGE_LINE =
  "Stripe's billing login page is on. During a free month, plan changes made there are caught by the free-days check.";
