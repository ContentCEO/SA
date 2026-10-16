import "server-only";
import { and, asc, eq, exists, inArray, isNotNull, isNull, not, or, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { mailboxLimitFor, planAbove, pricing, type PlanId } from "@/config/pricing";
import { db } from "@/db";
import {
  activityLog,
  mailboxes,
  referralCredits,
  rules,
  users,
  workspaces,
  type ReferralAdminFlag,
  type ReferralCredit,
  type ReferralSkipReason,
  type Workspace,
} from "@/db/schema";
import { stripeClient, stripeConfigured, stripeMode } from "./billing";
import { cancelAtOf, planFromLookupKey, planLookupKey } from "./billing-rules";
import { effectiveStatus, SENDING_ALLOWED } from "./lifecycle";
import {
  canAttach,
  chargesForFreeDays,
  classifyStripeError,
  couponOf,
  errorCodeOf,
  goBackOffer,
  idOf,
  invoiceUsed,
  isReferralCode,
  isReferralDiscount,
  isUniqueViolation,
  KEEP_CUTOFF_MS,
  keepOffer,
  linePriceId,
  newReferralCode,
  planLine,
  planLineFullyFree,
  portalSchedulesDowngrades,
  REFERRAL_COUPON_NAME,
  endChanges,
  type EndChanges,
  referralCouponId,
  referralLink,
  referralRefusal,
  referralReward,
  referredEmailHash,
} from "./referral-rules";
import { workspaceTimeZone } from "./snooze";
import {
  autopilotPlanEffects,
  inboxLimitEffects,
  resumeOverPlanInboxes,
} from "./workspace-lifecycle";

/**
 * Plan #47 referrals (behind FEATURE_REFERRALS). Offer A: the referrer's next month free, one
 * plan up. Logs carry ids and fixed codes only (A3) — never an email, a name, a Stripe customer
 * id or an error message.
 */

/** This workspace's referral code, made the first time it's needed. Stable afterwards. */
export async function ensureReferralCode(workspaceId: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [w] = await db()
      .select({ code: workspaces.referralCode })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    if (!w) throw new Error("Workspace not found.");
    if (w.code) return w.code;
    try {
      await db()
        .update(workspaces)
        .set({ referralCode: newReferralCode() })
        .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.referralCode)));
    } catch (err) {
      // Another workspace already has that code (1 in 2^72): try a new one. Anything else
      // (a dropped connection, a timeout) is not ours to swallow.
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error("Could not make a referral code.");
}

/**
 * The owner's share link for Plan & billing, or null if the code can't be made right now. A
 * side feature must never stop the page where the owner pays or updates their card: the
 * failure is logged (workspace id and error name only) and the section is hidden.
 */
export async function referralLinkFor(workspaceId: string): Promise<string | null> {
  try {
    return referralLink(await ensureReferralCode(workspaceId));
  } catch (err) {
    console.error("referral_code_failed", {
      workspaceId,
      error: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}

/** The workspace a referral code belongs to, or null (malformed or unknown codes too). */
export async function workspaceByReferralCode(code: unknown): Promise<string | null> {
  if (!isReferralCode(code)) return null;
  const [w] = await db()
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.referralCode, code));
  return w?.id ?? null;
}

async function ownerOf(workspaceId: string) {
  const [row] = await db()
    .select({ workspace: workspaces, email: users.email })
    .from(workspaces)
    .innerJoin(users, eq(users.id, workspaces.ownerUserId))
    .where(eq(workspaces.id, workspaceId));
  return row;
}

/**
 * Settle a referral, once ever (A9), the first time the referred workspace is active. The
 * referred owner must have really paid through Stripe (A27). Offer A: the referrer earns one
 * free month, one plan up, written as a `pending` row tagged with the Stripe mode it was earned
 * in; booking it on their subscription is the reward engine's job. Self, same-business-domain
 * and house-account referrers, or the switch being off at that moment, settle it as one
 * `skipped` row with the reason, and it is never given later. Returns what happened.
 */
export async function creditReferralOnActive(
  referredWorkspaceId: string,
  now: Date = new Date(),
): Promise<"earned" | "skipped"> {
  const referred = await ownerOf(referredWorkspaceId);
  const referrerId = referred?.workspace.referredByWorkspaceId;
  if (!referred || !referrerId) return "skipped";
  if (effectiveStatus(referred.workspace, now) !== "active") return "skipped";
  if (referred.workspace.setupPaidVia !== "stripe") return "skipped";
  // The referrer's workspace is gone (deleted mid-check): the FK clears the link, nothing to do.
  const referrer = await ownerOf(referrerId);
  if (!referrer) return "skipped";
  const refused = referralRefusal(
    { workspaceId: referrerId, ownerEmail: referrer.email },
    { workspaceId: referredWorkspaceId, ownerEmail: referred.email },
  );
  // Davi's own house account has no bill to make free.
  const skipReason: ReferralSkipReason | null =
    refused ??
    (referrer.workspace.setupPaidVia === "house" ? "house" : null) ??
    (referralReward() ? null : "off");

  const hash = referredEmailHash(referred.email);
  const inserted = await db().transaction(async (tx) => {
    // Two callers at once (webhook + sweep) queue here, so only one settles it.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`referral:${hash}`}))`);
    const [settled] = await tx
      .select({ id: referralCredits.id, referredWorkspaceId: referralCredits.referredWorkspaceId })
      .from(referralCredits)
      .where(eq(referralCredits.referredEmailSha256, hash))
      .limit(1);
    if (settled) {
      // This email's referral was settled by an earlier (since deleted) workspace: it's used
      // up. Drop the link so the sweep doesn't pick this workspace up every 15 minutes.
      if (settled.referredWorkspaceId !== referredWorkspaceId) {
        await tx
          .update(workspaces)
          .set({ referredByWorkspaceId: null })
          .where(eq(workspaces.id, referredWorkspaceId));
      }
      return [];
    }
    return tx
      .insert(referralCredits)
      .values({
        referredWorkspaceId,
        referredEmailSha256: hash,
        beneficiaryWorkspaceId: referrerId,
        side: "referrer",
        amountCents: 0,
        reward: "free_month_up",
        status: skipReason ? "skipped" : "pending",
        skipReason,
        stripeMode: skipReason ? null : stripeMode(),
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: referralCredits.id });
  });
  if (skipReason || inserted.length === 0) return "skipped";
  await db().insert(activityLog).values({
    workspaceId: referrerId,
    actor: "squared_away",
    action: "referral_reward_earned",
    detail: {},
    createdAt: now,
  });
  return "earned";
}

/**
 * Settle active referred workspaces whose move to active didn't reach creditReferralOnActive.
 * One bad account never stops the rest (A29). No-op while referrals are off.
 */
async function settleMissedReferrals(now: Date) {
  const result = { settled: 0 };
  if (!referralReward()) return result;

  const unsettled = await db()
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.status, "active"),
        eq(workspaces.setupPaidVia, "stripe"),
        isNotNull(workspaces.referredByWorkspaceId),
        not(
          exists(
            db()
              .select({ id: referralCredits.id })
              .from(referralCredits)
              .where(eq(referralCredits.referredWorkspaceId, workspaces.id)),
          ),
        ),
      ),
    );
  for (const w of unsettled) {
    try {
      if ((await creditReferralOnActive(w.id, now)) !== "skipped") result.settled++;
    } catch (err) {
      console.error("referral_settle_failed", {
        referredWorkspaceId: w.id,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  return result;
}

/**
 * For the Stripe webhook: reconcile the free months from the fresh subscription read, but never
 * fail the webhook (a Stripe 5xx in an invoice read must not undo the status and plan it just
 * applied). Logs ids and the error's name only; the 15-minute sweep catches up.
 */
export async function reconcileReferralSafely(
  workspaceId: string,
  sub: Stripe.Subscription | null,
  now: Date = new Date(),
) {
  try {
    await reconcileReferralRewards(workspaceId, sub, now);
  } catch (err) {
    console.error("referral_reconcile_failed", {
      workspaceId,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}

/**
 * For the status hooks (admin "setup call done", Stripe webhook): settle the referral, but never
 * fail or undo the move that called it. The sweep tries again.
 */
export async function creditReferralSafely(referredWorkspaceId: string, now: Date = new Date()) {
  try {
    return await creditReferralOnActive(referredWorkspaceId, now);
  } catch (err) {
    console.error("referral_settle_failed", {
      referredWorkspaceId,
      error: err instanceof Error ? err.name : "unknown",
    });
    return "skipped" as const;
  }
}

// =============================================================================================
// The reward engine (plan #47 offer A, design §1.4–1.10, §2, §3.7). Stripe keeps billing the
// plan the owner pays for; a one-time 100%-off coupon makes the next renewal's plan line free;
// the app grants the plan above for exactly that line's period. Every decision reads a fresh
// subscription; every write that could be repeated with a different intent carries a
// per-attempt idempotency key and is checked with a fresh read, never its own response. The
// only write that can raise a price is the owner's Keep tap.
// =============================================================================================

/** A lease on a reward row for one Stripe operation (attach, detach, strip, Keep, Go back). */
const LEASE_MS = 2 * 60_000;

type Sub = Stripe.Subscription;
type Row = ReferralCredit;
type W = Workspace;

const secs = (d: Date) => Math.floor(d.getTime() / 1000);
const fromSecs = (s: number) => new Date(s * 1000);
const item0 = (sub: Pick<Sub, "items">) => sub.items?.data?.[0];
const subEnded = (sub: Pick<Sub, "status">) =>
  sub.status === "canceled" || sub.status === "incomplete_expired";
const customerOf = (sub: Pick<Sub, "customer">) =>
  typeof sub.customer === "string" ? sub.customer : sub.customer.id;

function logFailure(row: Pick<Row, "id">, op: string, err: unknown) {
  // Ids and Stripe's fixed reason code only: never a Stripe message, customer id or amount.
  const reason = errorCodeOf(err);
  console.error("referral_reward_failed", { referralCreditId: row.id, op, reason });
}

/** Every subscription read: fresh, with discounts expanded (they are ids otherwise). */
function retrieveSub(id: string): Promise<Sub> {
  return stripeClient().subscriptions.retrieve(id, { expand: ["discounts"] });
}

/** A subscription read for reconciling: null when Stripe no longer has it, undefined if unknown. */
async function readSub(id: string): Promise<Sub | null | undefined> {
  try {
    return await retrieveSub(id);
  } catch (err) {
    if ((err as { code?: string }).code === "resource_missing") return null;
    const reason = errorCodeOf(err);
    console.error("referral_subscription_read_failed", { reason });
    return undefined;
  }
}

async function logActivity(
  workspaceId: string,
  action: string,
  detail: Record<string, unknown>,
  now: Date,
  actor: "squared_away" | "owner" = "squared_away",
  executor: Pick<ReturnType<typeof db>, "insert"> = db(),
) {
  await executor.insert(activityLog).values({ workspaceId, actor, action, detail, createdAt: now });
}

async function flag(row: Pick<Row, "id">, code: ReferralAdminFlag, now: Date) {
  await db()
    .update(referralCredits)
    .set({ adminFlag: code, flaggedAt: now })
    .where(eq(referralCredits.id, row.id));
}

/** Take the row's 2-minute lease while it is still in `status`. Null if someone else holds it. */
async function claim(row: Pick<Row, "id">, status: Row["status"], now: Date) {
  const [taken] = await db()
    .update(referralCredits)
    .set({ claimedAt: now })
    .where(
      and(
        eq(referralCredits.id, row.id),
        eq(referralCredits.status, status),
        or(
          isNull(referralCredits.claimedAt),
          sql`${referralCredits.claimedAt} < ${new Date(now.getTime() - LEASE_MS).toISOString()}::timestamptz`,
        ),
      ),
    )
    .returning();
  return taken ?? null;
}

async function release(row: Pick<Row, "id">, extra: Partial<Row> = {}) {
  await db()
    .update(referralCredits)
    .set({ claimedAt: null, ...extra })
    .where(eq(referralCredits.id, row.id));
}

/** A failed or uncertain Stripe write: count it (the next key differs), keep the code. */
async function missed(row: Pick<Row, "id" | "attempts">, err: unknown) {
  await release(row, { attempts: row.attempts + 1, lastErrorCode: errorCodeOf(err) });
}

/** Back to waiting, Stripe ids cleared; the next attach uses a new key. */
const BACK_TO_PENDING = {
  status: "pending" as const,
  stripeSubscriptionId: null,
  stripeCouponId: null,
  stripeDiscountId: null,
  stripeInvoiceId: null,
  attachedAt: null,
  startsAt: null,
  billingMode: null,
  claimedAt: null,
};

type ReturnWhy = "plan_ended" | "account_off" | "renewed_without" | "discount_removed";

async function backToPending(
  row: Row,
  why: ReturnWhy,
  now: Date,
  adminFlag: ReferralAdminFlag | null = null,
) {
  const [moved] = await db()
    .update(referralCredits)
    .set({
      ...BACK_TO_PENDING,
      attempts: row.attempts + 1,
      ...(adminFlag ? { adminFlag, flaggedAt: now } : {}),
    })
    .where(and(eq(referralCredits.id, row.id), eq(referralCredits.status, "scheduled")))
    .returning({ id: referralCredits.id });
  if (moved && row.beneficiaryWorkspaceId)
    await logActivity(row.beneficiaryWorkspaceId, "referral_reward_returned", { why }, now);
}

/** A discounts-only update that removes our coupon and passes back every other discount. */
async function removeOurDiscount(row: Row, subId: string, op: "detach" | "strip") {
  const sub = await retrieveSub(subId);
  if (!sub.discounts.some((d) => couponOf(d) === row.stripeCouponId)) return true;
  const keep = sub.discounts
    .filter((d) => couponOf(d) !== row.stripeCouponId)
    .map((d) => ({ discount: idOf(d) }));
  await stripeClient().subscriptions.update(
    subId,
    { discounts: keep.length ? keep : "" },
    { idempotencyKey: `referral-${op}-${row.id}-a${row.attempts}` },
  );
  const after = await retrieveSub(subId);
  return !after.discounts.some((d) => couponOf(d) === row.stripeCouponId);
}

// --- Attach ---------------------------------------------------------------------------------

type RunContext = {
  /** The portal's default configuration schedules downgrades (read once per run; null = unknown). */
  portal: () => Promise<boolean | null>;
};

function runContext(): RunContext {
  let cached: Promise<boolean | null> | undefined;
  return {
    portal: () =>
      (cached ??= (async () => {
        try {
          const list = await stripeClient().billingPortal.configurations.list({
            is_default: true,
            limit: 1,
          });
          const config = list.data[0];
          return config ? portalSchedulesDowngrades(config) : false;
        } catch (err) {
          const reason = errorCodeOf(err);
          console.error("referral_portal_read_failed", { reason });
          return null;
        }
      })()),
  };
}

/** The subscription without this reward's own coupon (a renewal that skipped it leaves it on). */
function withoutOwn(sub: Sub, row: Pick<Row, "id">): Sub {
  const own = referralCouponId(row.id);
  return { ...sub, discounts: sub.discounts.filter((d) => couponOf(d) !== own) };
}

/**
 * Book a waiting free month on the subscription (§1.4): make our coupon (deterministic id), add
 * it with every other non-referral discount passed back, and decide from a fresh read.
 */
async function attach(row: Row, w: W, sub: Sub, now: Date): Promise<"scheduled" | "waiting"> {
  const held = await claim(row, "pending", now);
  if (!held) return "waiting";
  const s = stripeClient();
  const couponId = referralCouponId(held.id);
  try {
    await s.coupons.create({
      id: couponId,
      percent_off: 100,
      duration: "once",
      name: REFERRAL_COUPON_NAME,
      metadata: { referralCreditId: held.id },
    });
  } catch (err) {
    const kind = classifyStripeError("coupon_create", err);
    if (kind === "permanent") {
      logFailure(held, "coupon_create", err);
      await release(held, { status: "failed", lastErrorCode: "coupon_refused" });
      return "waiting";
    }
    if (kind !== "ok") {
      logFailure(held, "coupon_create", err);
      await missed(held, err);
      return "waiting";
    }
  }
  let after: Sub;
  try {
    const fresh = await retrieveSub(sub.id);
    if (!fresh.discounts.some((d) => couponOf(d) === couponId)) {
      // Pass back every other discount (a Checkout promo code), never a referral one.
      const keep = fresh.discounts
        .filter((d) => !isReferralDiscount(d))
        .map((d) => ({ discount: idOf(d) }));
      await s.subscriptions.update(
        sub.id,
        { discounts: [...keep, { coupon: couponId }] },
        { idempotencyKey: `referral-attach-${held.id}-a${held.attempts}` },
      );
    }
    after = await retrieveSub(sub.id);
  } catch (err) {
    logFailure(held, "attach", err);
    // recheck or transient: either way it waits; the next try has a new key.
    await missed(held, err);
    return "waiting";
  }
  const ours = after.discounts.find((d) => couponOf(d) === couponId);
  const item = item0(after);
  if (!ours || typeof ours === "string" || !item) {
    await missed(held, { code: "not_attached" });
    return "waiting";
  }
  const startsAt = fromSecs(item.current_period_end);
  try {
    const [booked] = await db()
      .update(referralCredits)
      .set({
        status: "scheduled",
        stripeSubscriptionId: after.id,
        stripeCouponId: couponId,
        stripeDiscountId: ours.id,
        attachedAt: fromSecs(ours.start),
        startsAt,
        billingMode: after.billing_mode?.type ?? null,
        lastErrorCode: null,
        claimedAt: null,
      })
      .where(and(eq(referralCredits.id, held.id), eq(referralCredits.status, "pending")))
      .returning({ id: referralCredits.id });
    if (booked)
      await logActivity(
        w.id,
        "referral_free_month_scheduled",
        { startsAt: startsAt.toISOString() },
        now,
      );
    return booked ? "scheduled" : "waiting";
  } catch (err) {
    // Another reward of this workspace got booked first (one at a time).
    if (!isUniqueViolation(err)) throw err;
    await release(held);
    return "waiting";
  }
}

// --- Scheduled → running ----------------------------------------------------------------------

async function invoiceLines(inv: Stripe.Invoice): Promise<Stripe.InvoiceLineItem[]> {
  if (!inv.lines?.has_more) return inv.lines?.data ?? [];
  const all: Stripe.InvoiceLineItem[] = [];
  for await (const line of stripeClient().invoices.listLineItems(inv.id, { limit: 100 }))
    all.push(line);
  return all;
}

/** The renewal used our discount: the free month runs for exactly its plan line's period. */
async function startFreeMonth(row: Row, w: W, sub: Sub, inv: Stripe.Invoice, now: Date) {
  const line = planLine(await invoiceLines(inv), sub.id);
  const priceId = line ? linePriceId(line) : null;
  if (!line || !priceId) return false;
  const price = await stripeClient().prices.retrieve(priceId);
  const fromKey = planFromLookupKey(price.lookup_key);
  const paidPlan = fromKey ?? w.plan;
  if (!paidPlan) return false;
  const freePlan = planAbove(paidPlan);
  const endsAt = fromSecs(line.period.end);
  const fullyFree = planLineFullyFree(line, row.stripeDiscountId!);
  const adminFlag: ReferralAdminFlag | null = !fromKey
    ? "unknown_price"
    : fullyFree
      ? null
      : "not_fully_free";
  return db().transaction(async (tx) => {
    const [started] = await tx
      .update(referralCredits)
      .set({
        status: "running",
        stripeInvoiceId: inv.id,
        invoiceFinalAt: inv.status !== "draft" ? now : null,
        paidPlan,
        paidPriceId: price.id,
        paidPriceCents: price.unit_amount ?? null,
        freePlan,
        startsAt: fromSecs(line.period.start),
        endsAt,
        amountCents: pricing.plans[freePlan].amountCents,
        claimedAt: null,
        ...(adminFlag ? { adminFlag, flaggedAt: now } : {}),
      })
      .where(and(eq(referralCredits.id, row.id), eq(referralCredits.status, "scheduled")))
      .returning({ id: referralCredits.id });
    if (!started) return false;
    await tx
      .update(workspaces)
      .set({ freePlan, freePlanUntil: endsAt })
      .where(eq(workspaces.id, w.id));
    await resumeOverPlanInboxes(w.id, now, tx);
    await logActivity(
      w.id,
      "referral_free_month_started",
      { plan: freePlan, paidPlan, endsAt: endsAt.toISOString() },
      now,
      "squared_away",
      tx,
    );
    return true;
  });
}

/**
 * A booked free month, against the live subscription (§1.4 "Used?", §1.7): it started, Stripe
 * used it early, a renewal skipped it, it vanished, or the account stopped being on.
 */
async function checkScheduled(row: Row, w: W, sub: Sub | null | undefined, now: Date) {
  // The plan it was booked on ended (or the account moved to another subscription).
  if (
    sub === null ||
    (sub && subEnded(sub)) ||
    (w.stripeSubscriptionId ?? null) !== row.stripeSubscriptionId
  ) {
    await backToPending(row, "plan_ended", now);
    return;
  }
  if (!sub || !row.stripeDiscountId) return;
  const invoices = await stripeClient().invoices.list({ subscription: sub.id, limit: 10 });
  const used = invoices.data.find((i) => invoiceUsed(i, row.stripeDiscountId!));
  if (used) {
    if (used.billing_reason === "subscription_cycle") {
      await startFreeMonth(row, w, sub, used, now);
    } else {
      await db()
        .update(referralCredits)
        .set({ status: "failed", lastErrorCode: "used_early", claimedAt: null })
        .where(and(eq(referralCredits.id, row.id), eq(referralCredits.status, "scheduled")));
      console.error("referral_reward_failed", {
        referralCreditId: row.id,
        op: "used",
        reason: "used_early",
      });
    }
    return;
  }
  const start = row.startsAt ? secs(row.startsAt) : null;
  const skipped =
    start != null &&
    invoices.data.some((i) => {
      if (i.billing_reason !== "subscription_cycle") return false;
      const line = planLine(i.lines?.data ?? [], sub.id);
      return !!line && line.period.start >= start;
    });
  if (skipped) {
    await backToPending(row, "renewed_without", now, "renewed_without_discount");
    return;
  }
  const readable = sub.discounts.every((d) => typeof d !== "string");
  if (readable && !sub.discounts.some((d) => couponOf(d) === row.stripeCouponId)) {
    await backToPending(row, "discount_removed", now, "discount_removed");
    return;
  }
  // One rule: a free month only starts while the account is on. Detach (others kept).
  const on = SENDING_ALLOWED.includes(effectiveStatus(w, now)) && w.setupPaidVia === "stripe";
  if (!on) {
    const held = await claim(row, "scheduled", now);
    if (!held) return;
    try {
      if (await removeOurDiscount(held, sub.id, "detach")) {
        await backToPending(held, "account_off", now);
      } else {
        await missed(held, { code: "not_detached" });
      }
    } catch (err) {
      logFailure(held, "detach", err);
      await missed(held, err);
    }
  }
}

// --- Running: confirm, backstop, end --------------------------------------------------------

/** Remove pending charges Stripe added for days of the free month (§1.8 backstop). */
async function removeChargesForFreeDays(row: Row, sub: Sub, now: Date): Promise<number> {
  if (!row.startsAt || !row.endsAt) return 0;
  const items: Stripe.InvoiceItem[] = [];
  for await (const it of stripeClient().invoiceItems.list({
    customer: customerOf(sub),
    pending: true,
    limit: 100,
  }))
    items.push(it);
  let removed = 0;
  for (const id of chargesForFreeDays(items, sub.id, row.startsAt, row.endsAt)) {
    try {
      await stripeClient().invoiceItems.del(id);
      removed++;
    } catch (err) {
      if (classifyStripeError("invoice_item_delete", err) === "ok") continue;
      logFailure(row, "invoice_item_delete", err);
    }
  }
  if (removed) await flag(row, "plan_changed_in_free_month", now);
  return removed;
}

/** Keep `workspaces.plan` and the row's Keep record in line with what Stripe bills. */
async function syncBilledPlan(row: Row, w: W, sub: Sub, now: Date) {
  const item = item0(sub);
  const billed = planFromLookupKey(item?.price?.lookup_key);
  if (!billed) return;
  if (billed !== w.plan) {
    const movedDown = mailboxLimitFor(billed) < mailboxLimitFor(w.plan);
    await db().transaction(async (tx) => {
      await tx.update(workspaces).set({ plan: billed }).where(eq(workspaces.id, w.id));
      await autopilotPlanEffects(w.id, now, tx);
      if (movedDown) await inboxLimitEffects(w.id, now, tx);
      await resumeOverPlanInboxes(w.id, now, tx);
    });
  }
  // The Keep record follows Stripe; a change the owner didn't tap here is never "you chose".
  const leased = row.claimedAt && row.claimedAt.getTime() > now.getTime() - LEASE_MS;
  if (leased || !row.freePlan || row.freePlan === row.paidPlan) return;
  if (row.keptAt && billed !== row.freePlan) {
    await db()
      .update(referralCredits)
      .set({
        keptAt: null,
        keptPriceCents: null,
        adminFlag: "plan_changed_in_free_month",
        flaggedAt: now,
      })
      .where(eq(referralCredits.id, row.id));
  } else if (!row.keptAt && billed === row.freePlan) {
    await db()
      .update(referralCredits)
      .set({
        keptAt: now,
        keptPriceCents: item?.price?.unit_amount ?? null,
        adminFlag: "plan_changed_in_free_month",
        flaggedAt: now,
      })
      .where(eq(referralCredits.id, row.id));
  }
}

/**
 * The free month ends (§3.7), in one transaction: the row is done, the free plan is cleared,
 * and the plan effects run on the plan it goes back to. Needs no Stripe call.
 */
async function endFreeMonth(row: Row, w: W, now: Date): Promise<boolean> {
  return db().transaction(async (tx) => {
    const [ended] = await tx
      .update(referralCredits)
      .set({ status: "done", endedAt: now, claimedAt: null })
      .where(and(eq(referralCredits.id, row.id), eq(referralCredits.status, "running")))
      .returning({ id: referralCredits.id });
    if (!ended) return false;
    const [back] = await tx
      .update(workspaces)
      .set({ freePlan: null, freePlanUntil: null })
      .where(eq(workspaces.id, w.id))
      .returning({ plan: workspaces.plan });
    await autopilotPlanEffects(w.id, now, tx);
    await inboxLimitEffects(w.id, now, tx);
    await logActivity(
      w.id,
      "referral_free_month_ended",
      { plan: row.freePlan, backTo: back?.plan ?? null },
      now,
      "squared_away",
      tx,
    );
    return true;
  });
}

/** After the end, with Stripe: strip our discount if it's still on, flag charged free days. */
async function afterEnd(row: Row, sub: Sub, now: Date) {
  if (row.stripeSubscriptionId !== sub.id || subEnded(sub)) return;
  await stripLingering(
    row,
    sub,
    now,
    row.invoiceFinalAt ? "discount_lingered" : "invoice_not_final",
  );
  const item = item0(sub);
  if (!row.startsAt || !row.endsAt || !item) return;
  if (item.current_period_start < secs(row.endsAt)) {
    // Stripe hasn't renewed yet: one last sweep of charges for free days.
    await removeChargesForFreeDays(row, sub, now);
    return;
  }
  // Stripe renewed: a charge for free days already on the renewal invoice is for Davi to credit.
  const invoices = await stripeClient().invoices.list({ subscription: sub.id, limit: 10 });
  const s = secs(row.startsAt);
  const e = secs(row.endsAt);
  const renewal = invoices.data.find((i) => {
    if (i.billing_reason !== "subscription_cycle") return false;
    const line = planLine(i.lines?.data ?? [], sub.id);
    return !!line && line.period.start >= e;
  });
  const charged = renewal?.lines?.data?.some(
    (l) =>
      (l.parent?.invoice_item_details?.proration ||
        l.parent?.subscription_item_details?.proration) &&
      l.amount > 0 &&
      l.period.start < e &&
      l.period.end > s,
  );
  if (charged) await flag(row, "charged_for_free_days", now);
}

/** Our used (or never-used) discount still on the subscription: take it off, others kept. */
async function stripLingering(row: Row, sub: Sub, now: Date, code: ReferralAdminFlag) {
  if (!row.stripeCouponId || !sub.discounts.some((d) => couponOf(d) === row.stripeCouponId)) return;
  const held = await claim(row, row.status, now);
  if (!held) return;
  try {
    if (await removeOurDiscount(held, sub.id, "strip")) {
      await release(held, { adminFlag: code, flaggedAt: now, attempts: held.attempts + 1 });
    } else {
      await missed(held, { code: "not_stripped" });
    }
  } catch (err) {
    logFailure(held, "strip", err);
    await missed(held, err);
  }
}

async function checkRunning(row: Row, w: W, sub: Sub | null | undefined, now: Date) {
  const mine = sub && sub.id === row.stripeSubscriptionId ? sub : null;
  const item = mine ? item0(mine) : undefined;
  const over =
    !!row.endsAt &&
    (now.getTime() >= row.endsAt.getTime() ||
      (!!item && item.current_period_start >= secs(row.endsAt)));
  if (over) {
    if ((await endFreeMonth(row, w, now)) && mine && stripeConfigured()) {
      try {
        await afterEnd({ ...row, status: "done" }, mine, now);
      } catch (err) {
        logFailure(row, "after_end", err);
      }
    }
    return;
  }
  if (!mine) return;
  // Provisional until Stripe finalizes the invoice that used it (the coupon is spent then).
  let finalAt = row.invoiceFinalAt;
  if (!finalAt && row.stripeInvoiceId) {
    const inv = await stripeClient().invoices.retrieve(row.stripeInvoiceId);
    if (inv.status !== "draft") {
      finalAt = now;
      await db()
        .update(referralCredits)
        .set({ invoiceFinalAt: now })
        .where(eq(referralCredits.id, row.id));
    }
  }
  if (finalAt) await stripLingering(row, mine, now, "discount_lingered");
  await removeChargesForFreeDays(row, mine, now);
  await syncBilledPlan(row, w, mine, now);
}

// --- Per workspace --------------------------------------------------------------------------

/**
 * Bring this workspace's free months in line with its live subscription: end a running one
 * (wall clock or Stripe's renewal), check a booked one, then book the next waiting one. `seed`
 * is a subscription already read fresh (the webhook's); others are read as needed.
 */
export async function reconcileReferralRewards(
  workspaceId: string,
  seed: Sub | null,
  now: Date = new Date(),
  ctx: RunContext = runContext(),
): Promise<void> {
  const open = await db()
    .select()
    .from(referralCredits)
    .where(
      and(
        eq(referralCredits.beneficiaryWorkspaceId, workspaceId),
        inArray(referralCredits.status, ["pending", "scheduled", "running"]),
      ),
    )
    .orderBy(asc(referralCredits.createdAt), asc(referralCredits.id));
  if (!open.length) return;
  const [w] = await db().select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!w) return;

  const subs = new Map<string, Promise<Sub | null | undefined>>();
  if (seed) subs.set(seed.id, Promise.resolve(seed));
  const subFor = (id: string | null): Promise<Sub | null | undefined> => {
    if (!id) return Promise.resolve(null);
    if (!stripeConfigured()) return Promise.resolve(undefined);
    if (!subs.has(id)) subs.set(id, readSub(id));
    return subs.get(id)!;
  };

  const running = open.find((r) => r.status === "running");
  if (running) await checkRunning(running, w, await subFor(running.stripeSubscriptionId), now);
  const scheduled = open.find((r) => r.status === "scheduled");
  if (scheduled && stripeConfigured())
    await checkScheduled(scheduled, w, await subFor(scheduled.stripeSubscriptionId), now);

  const pending = open.find((r) => r.status === "pending");
  if (!pending) return;
  await attachIfReady(pending, workspaceId, subFor, ctx, now);
}

async function attachIfReady(
  pending: Row,
  workspaceId: string,
  subFor: (id: string | null) => Promise<Sub | null | undefined>,
  ctx: RunContext,
  now: Date,
) {
  // Fresh rows: the steps above may have ended, started or returned a free month.
  const [w] = await db().select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!w || !stripeConfigured()) return;
  const others = await db()
    .select({ status: referralCredits.status, endsAt: referralCredits.endsAt })
    .from(referralCredits)
    .where(
      and(
        eq(referralCredits.beneficiaryWorkspaceId, workspaceId),
        inArray(referralCredits.status, ["scheduled", "running", "done"]),
      ),
    );
  const base = {
    rewardOn: referralReward() !== null,
    rowMode: pending.stripeMode,
    keyMode: stripeMode(),
    otherFreeMonth: others.some((o) => o.status !== "done"),
    portalSchedulesDowngrades: false,
  };
  // Waits that need no Stripe call come first, so a waiting reward costs nothing.
  if (canAttach(w, null, base, now).some((r) => r !== "no_subscription")) return;
  const sub = await subFor(w.stripeSubscriptionId);
  if (!sub) return;
  // One free month at a time, with a paid month between (§1.10): the current period must have
  // started at or after the last free month's end, or our coupon would free the very next one.
  const item = item0(sub);
  const lastEnd = Math.max(0, ...others.map((o) => (o.endsAt ? secs(o.endsAt) : 0)));
  if (!item || item.current_period_start < lastEnd) return;
  const waits = canAttach(
    w,
    withoutOwn(sub, pending),
    { ...base, portalSchedulesDowngrades: await ctx.portal() },
    now,
  );
  if (waits.length) return;
  await attach(pending, w, sub, now);
}

/**
 * The 15-minute sweep (replaces the old balance-credit sweep): settle referrals whose move to
 * active was missed, then reconcile every workspace with a free month waiting, booked or
 * running. A running month always ends, even with referrals switched off; while off, waiting
 * rewards are left alone (no Stripe call). The portal's default configuration is read at most
 * once per run. One bad account never stops the rest.
 */
export async function runReferralRewards(now: Date = new Date()) {
  const { settled } = await settleMissedReferrals(now);
  const result = { settled, reconciled: 0, failed: 0 };
  const statuses: Row["status"][] = referralReward()
    ? ["pending", "scheduled", "running"]
    : ["scheduled", "running"];
  const due = await db()
    .selectDistinct({ id: referralCredits.beneficiaryWorkspaceId })
    .from(referralCredits)
    .where(
      and(
        isNotNull(referralCredits.beneficiaryWorkspaceId),
        inArray(referralCredits.status, statuses),
      ),
    );
  const ctx = runContext();
  for (const { id } of due) {
    if (!id) continue;
    try {
      await reconcileReferralRewards(id, null, now, ctx);
      result.reconciled++;
    } catch (err) {
      result.failed++;
      console.error("referral_reconcile_failed", {
        workspaceId: id,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  return result;
}

// --- Keep / Go back (§2): the owner's tap, the only writes that change a price ----------------

export type PlanChangeOutcome =
  | { status: "kept"; plan: PlanId; priceCents: number; from: Date }
  | { status: "went_back"; plan: PlanId; priceCents: number; from: Date }
  | { status: "set_to_end"; at: Date }
  | {
      status:
        | "not_offered"
        | "price_changed"
        | "busy"
        | "stripe_off"
        | "stripe_down"
        | "changed"
        | "schedule"
        | "ended";
    };

/** The current config price for a plan, found by lookup key (never created here). */
async function configPriceId(plan: PlanId): Promise<string | null> {
  const found = await stripeClient().prices.list({
    lookup_keys: [planLookupKey(plan)],
    active: true,
    limit: 1,
  });
  return found.data[0]?.id ?? null;
}

async function changePlan(
  kind: "keep" | "go_back",
  workspaceId: string,
  input: { rewardId: string; plan?: PlanId; priceCents?: number },
  now: Date,
): Promise<PlanChangeOutcome> {
  const [row] = await db()
    .select()
    .from(referralCredits)
    .where(
      and(
        eq(referralCredits.id, input.rewardId),
        eq(referralCredits.beneficiaryWorkspaceId, workspaceId),
      ),
    );
  const [w] = await db().select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!row || !w) return { status: "not_offered" };
  const keep = kind === "keep" ? keepOffer(w, row, now) : null;
  const back = kind === "go_back" ? goBackOffer(w, row, now) : null;
  if (!keep && !back) return { status: "not_offered" };
  // The owner confirmed this plan at this price: anything else is refused.
  if (keep && (input.plan !== keep.plan || input.priceCents !== keep.priceCents))
    return { status: "price_changed" };
  if (!stripeConfigured()) return { status: "stripe_off" };
  const subId = w.stripeSubscriptionId ?? row.stripeSubscriptionId;
  if (!subId) return { status: "changed" };

  // Claim with a fresh key: every tap gets its own idempotency key.
  const [claimed] = await db()
    .update(referralCredits)
    .set({ planChangeSeq: sql`${referralCredits.planChangeSeq} + 1`, claimedAt: now })
    .where(
      and(
        eq(referralCredits.id, row.id),
        eq(referralCredits.beneficiaryWorkspaceId, workspaceId),
        eq(referralCredits.status, "running"),
        or(
          isNull(referralCredits.claimedAt),
          sql`${referralCredits.claimedAt} < ${new Date(now.getTime() - LEASE_MS).toISOString()}::timestamptz`,
        ),
      ),
    )
    .returning({ seq: referralCredits.planChangeSeq });
  if (!claimed) return { status: "busy" };
  const refuse = async (outcome: PlanChangeOutcome) => {
    await release(row);
    return outcome;
  };

  const s = stripeClient();
  let target: string | null;
  let sub: Sub;
  try {
    sub = await retrieveSub(subId);
    target = keep ? await configPriceId(keep.plan) : row.paidPriceId;
  } catch (err) {
    logFailure(row, kind, err);
    return refuse({
      status: classifyStripeError("plan_change", err) === "recheck" ? "changed" : "stripe_down",
    });
  }
  const cancelAt = cancelAtOf(sub);
  if (cancelAt) return refuse({ status: "set_to_end", at: cancelAt });
  if (sub.schedule != null) return refuse({ status: "schedule" });
  const item = item0(sub);
  if (sub.status !== "active" || sub.items.data.length !== 1 || !item || !target)
    return refuse({ status: "changed" });
  if (
    item.current_period_start >= secs(row.endsAt!) ||
    now.getTime() >= row.endsAt!.getTime() - KEEP_CUTOFF_MS
  )
    return refuse({ status: "ended" });

  // Plans are compared by lookup key, never by price id (an older price of the plan is fine).
  const itemPlan = planFromLookupKey(item.price.lookup_key);
  const targetPlan = keep ? keep.plan : back!.plan;
  const already = keep ? itemPlan === targetPlan : item.price.id === target;
  if (!already) {
    if (keep && itemPlan !== row.paidPlan) return refuse({ status: "changed" });
    if (back && itemPlan !== row.freePlan) return refuse({ status: "changed" });
    // Belt and braces: going back never costs more than the plan they're on now.
    if (back && (row.paidPriceCents ?? 0) > (item.price.unit_amount ?? 0))
      return refuse({ status: "changed" });
    try {
      await s.subscriptions.update(
        sub.id,
        { items: [{ id: item.id, price: target }], proration_behavior: "none" },
        { idempotencyKey: `referral-plan-${row.id}-v${claimed.seq}` },
      );
    } catch (err) {
      logFailure(row, kind, err);
      return refuse({
        status: classifyStripeError("plan_change", err) === "recheck" ? "changed" : "stripe_down",
      });
    }
  }
  let after: Sub;
  try {
    after = await retrieveSub(sub.id);
  } catch (err) {
    logFailure(row, kind, err);
    return refuse({ status: "stripe_down" });
  }
  const afterItem = item0(after);
  const landed = keep
    ? planFromLookupKey(afterItem?.price?.lookup_key) === targetPlan
    : afterItem?.price?.id === target;
  if (!landed) return refuse({ status: "changed" });
  const billed = planFromLookupKey(afterItem?.price?.lookup_key) ?? w.plan;

  await db().transaction(async (tx) => {
    await tx.update(workspaces).set({ plan: billed }).where(eq(workspaces.id, w.id));
    const [recorded] = await tx
      .update(referralCredits)
      .set(
        keep
          ? { keptAt: now, keptPriceCents: keep.priceCents, claimedAt: null }
          : { keptAt: null, keptPriceCents: null, claimedAt: null },
      )
      .where(
        and(
          eq(referralCredits.id, row.id),
          eq(referralCredits.status, "running"),
          keep ? isNull(referralCredits.keptAt) : isNotNull(referralCredits.keptAt),
        ),
      )
      .returning({ id: referralCredits.id });
    if (!recorded) {
      await tx
        .update(referralCredits)
        .set({ claimedAt: null })
        .where(eq(referralCredits.id, row.id));
      return;
    }
    // The proof of the owner's okay: what they chose, at what price, from when.
    await logActivity(
      w.id,
      keep ? "referral_plan_kept" : "referral_keep_undone",
      keep
        ? {
            plan: keep.plan,
            priceCents: keep.priceCents,
            firstChargeAt: keep.firstChargeAt.toISOString(),
          }
        : { plan: back!.plan, priceCents: back!.priceCents, at: back!.at.toISOString() },
      now,
      "owner",
      tx,
    );
    await autopilotPlanEffects(w.id, now, tx);
    await inboxLimitEffects(w.id, now, tx);
    await resumeOverPlanInboxes(w.id, now, tx);
  });
  return keep
    ? { status: "kept", plan: keep.plan, priceCents: keep.priceCents, from: keep.firstChargeAt }
    : { status: "went_back", plan: back!.plan, priceCents: back!.priceCents, from: back!.at };
}

/**
 * "Keep Crew" (§2): from the end of the free month, the owner pays for the free plan at today's
 * config price, which they confirmed (`priceCents`). No invoice now; the first charge is the
 * renewal at the end of the free month.
 */
export function keepFreePlan(
  workspaceId: string,
  input: { rewardId: string; plan: PlanId; priceCents: number },
  now: Date = new Date(),
) {
  return changePlan("keep", workspaceId, input, now);
}

/** "Go back to Solo" after a Keep: exactly the price they paid before (`paid_price_id`). */
export function goBackToPaidPlan(
  workspaceId: string,
  input: { rewardId: string },
  now: Date = new Date(),
) {
  return changePlan("go_back", workspaceId, input, now);
}

// --- What the owner's screens show (§4) -------------------------------------------------------

export type FreeMonthView = {
  /** The free month running now, or null. */
  running: ReferralCredit | null;
  /** The earned month that hasn't started yet: the booked one, else the oldest waiting one. */
  waiting: Pick<ReferralCredit, "id" | "status" | "startsAt"> | null;
  /** `waiting` is pending while another free month is booked or running. */
  anotherFreeMonth: boolean;
  /** Live counts behind "what changes at the end" (only read while a month runs). */
  countedInboxes: number;
  autopilotCategoriesOn: number;
  timeZone: string;
};

/**
 * Everything Plan & billing, the banner and Settings need about free months, from the database
 * only (never a Stripe call on a page load). Rows are this workspace's own; no other workspace's
 * data and nothing about the referred owner.
 */
export async function freeMonthView(workspaceId: string): Promise<FreeMonthView> {
  const rows = await db()
    .select()
    .from(referralCredits)
    .where(
      and(
        eq(referralCredits.beneficiaryWorkspaceId, workspaceId),
        inArray(referralCredits.status, ["pending", "scheduled", "running"]),
      ),
    )
    .orderBy(asc(referralCredits.createdAt), asc(referralCredits.id));
  const running = rows.find((r) => r.status === "running") ?? null;
  const scheduled = rows.find((r) => r.status === "scheduled") ?? null;
  const pending = rows.find((r) => r.status === "pending") ?? null;
  const waiting = scheduled ?? pending;
  let countedInboxes = 0;
  let autopilotCategoriesOn = 0;
  if (running) {
    const [inboxRows, ruleRows] = await Promise.all([
      db()
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(and(eq(mailboxes.workspaceId, workspaceId), isNull(mailboxes.pausedReason))),
      db()
        .select({ category: rules.category })
        .from(rules)
        .where(and(eq(rules.workspaceId, workspaceId), eq(rules.mode, "autopilot"))),
    ]);
    countedInboxes = inboxRows.length;
    autopilotCategoriesOn = ruleRows.length;
  }
  return {
    running,
    waiting: waiting
      ? { id: waiting.id, status: waiting.status, startsAt: waiting.startsAt }
      : null,
    anotherFreeMonth: !scheduled && !!pending && !!running,
    countedInboxes,
    autopilotCategoriesOn,
    timeZone: await workspaceTimeZone(workspaceId),
  };
}

/** What will change at the end if the account is then on `to` (live counts). */
export function viewChanges(view: FreeMonthView, to: PlanId | null): EndChanges {
  return endChanges({
    to,
    countedInboxes: view.countedInboxes,
    autopilotCategoriesOn: view.autopilotCategoriesOn,
  });
}

// --- Reset test payments and account deletion (§3.1, §1.7) ------------------------------------

/**
 * "Reset test payments" (live key only): free months earned in test mode are deleted, so the
 * referred owner's real payment settles the referral again, once (the fingerprint is free
 * again). A running test-mode month stops: its free plan is cleared and the plan effects run in
 * the same transaction, as at any other end. Returns how many rows went.
 *
 * Only rewards whose referred account no longer stands as paid through Stripe go: one the reset
 * couldn't check (Stripe didn't answer, or it changed while we looked) is still `active` with
 * `setup_paid_via = 'stripe'` on test money, and deleting its fingerprint would let the next
 * sweep settle it again on the live key. Kept rows go on the next reset that resets the account.
 */
export async function clearTestModeRewards(now: Date = new Date()): Promise<number> {
  const stillPaid = db()
    .select({ one: sql`1` })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, referralCredits.referredWorkspaceId),
        eq(workspaces.setupPaidVia, "stripe"),
      ),
    );
  return db().transaction(async (tx) => {
    const gone = await tx
      .delete(referralCredits)
      .where(and(eq(referralCredits.stripeMode, "test"), not(exists(stillPaid))))
      .returning({
        status: referralCredits.status,
        beneficiaryWorkspaceId: referralCredits.beneficiaryWorkspaceId,
      });
    const stopped = [
      ...new Set(
        gone
          .filter((r) => r.status === "running" && r.beneficiaryWorkspaceId)
          .map((r) => r.beneficiaryWorkspaceId!),
      ),
    ];
    for (const id of stopped) {
      await tx
        .update(workspaces)
        .set({ freePlan: null, freePlanUntil: null })
        .where(eq(workspaces.id, id));
      await autopilotPlanEffects(id, now, tx);
      await inboxLimitEffects(id, now, tx);
    }
    return gone.length;
  });
}
