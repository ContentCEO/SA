import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pricing, type PlanId } from "@/config/pricing";
import type { Database } from "@/db";
import {
  activityLog,
  drafts,
  mailboxes,
  referralCredits,
  rules,
  threads,
  workspaces,
  type Workspace,
} from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { accountLockReason } from "@/server/autopilot";
import { applySubscription, setStripeForTests } from "@/server/billing";
import { planLookupKey } from "@/server/billing-rules";
import { mailboxLimit, saveConnectedMailbox } from "@/server/mailboxes";
import {
  effectivePlan,
  REFERRAL_COUPON_NAME,
  referralCouponId,
  setReferralConfigForTests,
} from "@/server/referral-rules";
import { goBackToPaidPlan, keepFreePlan, runReferralRewards } from "@/server/referrals";
import { createTestDb } from "../support/db";
import { FakeStripe, fromSeconds, stripeErrors, type Call } from "../support/fake-stripe";

/**
 * Plan #47 offer A, the reward engine (design §1.4–1.10, §2, §3.7, §5.3): booking a free month
 * as a one-time coupon on the referrer's live subscription, starting it from the renewal
 * invoice that used it, ending it on whichever comes first (Stripe's renewal or our clock),
 * Keep / Go back, and the backstop for charges on free days. Everything runs against the fake
 * Stripe account in tests/support/fake-stripe.ts.
 */

const NOW = new Date("2026-10-16T14:00:00Z");
const DAY = 86_400_000;
const later = (ms: number) => new Date(NOW.getTime() + ms);
const PRICE = { solo: "price_solo", crew: "price_crew", company: "price_company" } as const;

let database: Database;
let fake: FakeStripe;
let w: Workspace;
let wid: string;
let rewardId: string;
let n = 0;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AUTH_SECRET = "test-secret";
  process.env.APP_URL = "https://app.example";
  process.env.FEATURE_REFERRALS = "1";
  process.env.STRIPE_SECRET_KEY = "sk_" + "test_" + "fake";
  setReferralConfigForTests({ reward: "free_month_one_plan_up" });
  database = await createTestDb();
  fake = new FakeStripe({ now: NOW });
  setStripeForTests(fake.client);
  for (const plan of ["solo", "crew", "company"] as const)
    fake.addPrice({
      id: PRICE[plan],
      lookup_key: planLookupKey(plan),
      unit_amount: pricing.plans[plan].amountCents,
    });
  fake.addPortalConfiguration({ id: "bpc_default" });
  const { workspace } = await ensureUserAndWorkspace({ email: "rosa@gmail.com" });
  wid = workspace.id;
  await database
    .update(workspaces)
    .set({
      status: "active",
      plan: "solo",
      setupPaidAt: NOW,
      setupPaidVia: "stripe",
      setupCallCompletedAt: NOW,
      stripeCustomerId: "cus_ref",
      stripeSubscriptionId: "sub_ref",
    })
    .where(eq(workspaces.id, workspace.id));
  w = await load();
  fake.addSubscription({
    id: "sub_ref",
    customer: "cus_ref",
    price: PRICE.solo,
    workspaceId: w.id,
  });
  rewardId = await earn();
});

afterEach(() => {
  setStripeForTests(undefined);
  setReferralConfigForTests(undefined);
  delete process.env.FEATURE_REFERRALS;
  delete process.env.STRIPE_SECRET_KEY;
  vi.restoreAllMocks();
});

// --- Helpers --------------------------------------------------------------------------------

async function load() {
  const [row] = await database.select().from(workspaces).where(eq(workspaces.id, wid));
  return row!;
}
const set = (values: Partial<Workspace>) =>
  database.update(workspaces).set(values).where(eq(workspaces.id, w.id));

/** A settled referral: one waiting free month, earned in test mode. */
async function earn(mode: "live" | "test" = "test", createdAt = NOW): Promise<string> {
  const [row] = await database
    .insert(referralCredits)
    .values({
      referredEmailSha256: `hash-${++n}`,
      beneficiaryWorkspaceId: w.id,
      side: "referrer",
      amountCents: 0,
      reward: "free_month_up",
      status: "pending",
      stripeMode: mode,
      createdAt,
    })
    .returning();
  return row!.id;
}

const reward = async (id = rewardId) =>
  (await database.select().from(referralCredits).where(eq(referralCredits.id, id)))[0]!;
const sub = () => fake.sub("sub_ref");
const item = () => sub().items.data[0]!;
const log = async () =>
  (await database.select().from(activityLog))
    .filter((l) => /referral|autopilot_turned|inbox/.test(l.action))
    .map((l) => [l.action, l.detail, l.actor]);
const writes = () => fake.writes.map((c) => c.method);
const updates = () => fake.writes.filter((c) => c.method === "subscriptions.update");

/** A Stripe event for the referrer's subscription (its snapshot may be stale; the read isn't). */
const event = (plan: PlanId = "solo", status = "active") =>
  ({
    id: "sub_ref",
    status,
    metadata: { workspaceId: w.id },
    items: { data: [{ price: { lookup_key: planLookupKey(plan) } }] },
  }) as unknown as Stripe.Subscription;
const webhook = (at: Date, plan: PlanId = "solo", status = "active") =>
  applySubscription(event(plan, status), at);

/** Book it (sweep), then Stripe renews with it: the free month is running. */
async function startFreeMonth(opts: { finalize?: boolean | "fails" } = {}) {
  await runReferralRewards(NOW);
  expect((await reward()).status).toBe("scheduled");
  const inv = fake.renew("sub_ref", opts);
  await webhook(fromSeconds(fake.clock));
  expect((await reward()).status).toBe("running");
  return inv;
}

/** An extra coupon + discount on the subscription, as a Checkout promotion code leaves one. */
async function addPromo() {
  const s = fake.client;
  await s.coupons.create({ id: "promo10", percent_off: 10, duration: "forever" });
  await s.subscriptions.update("sub_ref", { discounts: [{ coupon: "promo10" }] });
  const promo = sub().discounts[0] as Stripe.Discount;
  fake.writes.length = 0;
  fake.calls.length = 0;
  return promo.id;
}

// --- Attach ---------------------------------------------------------------------------------

describe("attach: a waiting free month is booked on the live subscription", () => {
  it("makes the coupon exactly as designed and adds only a discount (no plan change)", async () => {
    const r = await runReferralRewards(NOW);
    expect(r).toMatchObject({ reconciled: 1, failed: 0 });
    const coupon = fake.writes.find((c) => c.method === "coupons.create")!;
    expect(coupon.args[0]).toEqual({
      id: `sa_ref_${rewardId}`,
      percent_off: 100,
      duration: "once",
      name: REFERRAL_COUPON_NAME,
      metadata: { referralCreditId: rewardId },
    });
    expect(REFERRAL_COUPON_NAME).toBe("Referral thanks: this month is free");
    const [u] = updates();
    expect(u!.args).toEqual([
      "sub_ref",
      { discounts: [{ coupon: referralCouponId(rewardId) }] },
      { idempotencyKey: `referral-attach-${rewardId}-a0` },
    ]);
    const row = await reward();
    const ours = sub().discounts[0] as Stripe.Discount;
    expect(row).toMatchObject({
      status: "scheduled",
      stripeSubscriptionId: "sub_ref",
      stripeCouponId: referralCouponId(rewardId),
      stripeDiscountId: ours.id,
      billingMode: "flexible",
    });
    expect(row.attachedAt?.getTime()).toBe(ours.start * 1000);
    expect(row.startsAt?.getTime()).toBe(item().current_period_end * 1000);
    expect(await log()).toEqual([
      ["referral_free_month_scheduled", { startsAt: row.startsAt!.toISOString() }, "squared_away"],
    ]);
  });

  it("a second run (or the webhook) books nothing more", async () => {
    await runReferralRewards(NOW);
    const before = writes().length;
    await runReferralRewards(later(60_000));
    await webhook(later(120_000));
    expect(writes()).toHaveLength(before);
    expect(sub().discounts).toHaveLength(1);
  });

  it("passes back a promotion code's discount, and never a referral one", async () => {
    const promo = await addPromo();
    await runReferralRewards(NOW);
    const [u] = updates();
    expect((u!.args[1] as Stripe.SubscriptionUpdateParams).discounts).toEqual([
      { discount: promo },
      { coupon: referralCouponId(rewardId) },
    ]);
    expect((await reward()).status).toBe("scheduled");
  });

  it("a coupon already made by an earlier try is fine", async () => {
    await fake.client.coupons.create({
      id: referralCouponId(rewardId),
      percent_off: 100,
      duration: "once",
    });
    await runReferralRewards(NOW);
    expect((await reward()).status).toBe("scheduled");
  });

  it("a Stripe refusal leaves it waiting, counts the try, and the next try uses a new key", async () => {
    fake.failNext("subscriptions.update", stripeErrors.invalid("Something changed."));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await runReferralRewards(NOW);
    expect(await reward()).toMatchObject({
      status: "pending",
      attempts: 1,
      lastErrorCode: "parameter_invalid",
    });
    expect(errors).toHaveBeenCalledWith("referral_reward_failed", {
      referralCreditId: rewardId,
      op: "attach",
      reason: "parameter_invalid",
    });
    // The lease (2 minutes) has lapsed by the next sweep.
    await runReferralRewards(later(15 * 60_000));
    expect((await reward()).status).toBe("scheduled");
    expect(updates().at(-1)!.args[2]).toEqual({
      idempotencyKey: `referral-attach-${rewardId}-a1`,
    });
  });

  it("a held lease means a second runner books nothing (webhook and sweep at once)", async () => {
    await database
      .update(referralCredits)
      .set({ claimedAt: NOW })
      .where(eq(referralCredits.id, rewardId));
    await runReferralRewards(later(30_000));
    expect((await reward()).status).toBe("pending");
    expect(updates()).toEqual([]);
  });

  it("a coupon Stripe refuses outright fails the row for Davi", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.failNext("coupons.create", stripeErrors.invalid("Invalid percent_off"));
    await runReferralRewards(NOW);
    expect(await reward()).toMatchObject({ status: "failed", lastErrorCode: "coupon_refused" });
  });
});

describe("waits: nothing is written to Stripe", () => {
  const cases: [string, () => Promise<unknown>][] = [
    ["no subscription yet", () => set({ stripeSubscriptionId: null, status: "evaluating" })],
    ["past due", () => set({ status: "past_due" })],
    ["paused", () => set({ status: "paused" })],
    ["canceled", () => set({ status: "canceled", stripeSubscriptionId: null })],
    ["set up by hand, not through Stripe", () => set({ setupPaidVia: "house" })],
    [
      "set to end",
      async () => {
        sub().cancel_at_period_end = true;
      },
    ],
    [
      "a subscription schedule",
      async () => {
        sub().schedule = "sub_sched_1";
      },
    ],
    [
      "Stripe's billing page schedules downgrades",
      async () => {
        fake.portalConfigurations.get(
          "bpc_default",
        )!.features.subscription_update.schedule_at_period_end = {
          conditions: [{ type: "decreasing_item_amount" }],
        };
      },
    ],
    [
      "another referral discount already on",
      async () => {
        await fake.client.coupons.create({
          id: "sa_ref_other",
          percent_off: 100,
          duration: "once",
        });
        await fake.client.subscriptions.update("sub_ref", {
          discounts: [{ coupon: "sa_ref_other" }],
        });
        fake.writes.length = 0;
      },
    ],
    [
      "earned with test payments, while the key is live",
      async () => {
        process.env.STRIPE_SECRET_KEY = "sk_" + "live_" + "fake";
      },
    ],
    [
      "another free month already booked",
      async () => {
        await database
          .update(referralCredits)
          .set({ status: "scheduled", stripeSubscriptionId: "sub_ref" })
          .where(eq(referralCredits.id, await earn("test", new Date(NOW.getTime() - DAY))));
      },
    ],
  ];
  for (const [name, arrange] of cases) {
    it(name, async () => {
      await arrange();
      vi.spyOn(console, "error").mockImplementation(() => {});
      await runReferralRewards(NOW);
      expect((await reward()).status).toBe("pending");
      expect(writes()).toEqual([]);
    });
  }

  it("while referrals are off, a waiting reward isn't even looked at (zero Stripe calls)", async () => {
    delete process.env.FEATURE_REFERRALS;
    await runReferralRewards(NOW);
    await webhook(NOW);
    expect(fake.calls.filter((c) => c.method !== "subscriptions.retrieve")).toEqual([]);
    expect((await reward()).status).toBe("pending");
  });
});

// --- Running --------------------------------------------------------------------------------

describe("running: the renewal that used it starts the free month", () => {
  it("via the webhook: dates and price from the invoice's plan line; provisional until final", async () => {
    await runReferralRewards(NOW);
    const periodEnd = item().current_period_end;
    const inv = fake.renew("sub_ref");
    await webhook(fromSeconds(fake.clock));
    const row = await reward();
    expect(row).toMatchObject({
      status: "running",
      stripeInvoiceId: inv.id,
      paidPlan: "solo",
      paidPriceId: PRICE.solo,
      paidPriceCents: 9_900,
      freePlan: "crew",
      invoiceFinalAt: null,
      amountCents: pricing.plans.crew.amountCents,
      adminFlag: null,
    });
    expect(row.startsAt?.getTime()).toBe(periodEnd * 1000);
    expect(row.endsAt?.getTime()).toBe(item().current_period_end * 1000);
    const after = await load();
    expect(after.freePlan).toBe("crew");
    expect(after.freePlanUntil?.getTime()).toBe(row.endsAt!.getTime());
    const at = fromSeconds(fake.clock);
    expect(effectivePlan(after, at)).toBe("crew");
    expect(mailboxLimit(after, at)).toBe(3);
    expect(accountLockReason(after, at)).toBeNull();
    // The plan line is free; Stripe charges nothing for it.
    expect(inv.total).toBe(0);
    expect((await log()).filter(([a]) => a === "referral_free_month_started")).toEqual([
      [
        "referral_free_month_started",
        { plan: "crew", endsAt: row.endsAt!.toISOString() },
        "squared_away",
      ],
    ]);
    // Double delivery: one transition.
    await webhook(fromSeconds(fake.clock));
    expect((await log()).filter(([a]) => a === "referral_free_month_started")).toHaveLength(1);
    // Confirmed once Stripe finalizes the invoice (and spends the coupon).
    fake.finalize(inv.id);
    await runReferralRewards(fromSeconds(fake.clock + 3600));
    expect((await reward()).invoiceFinalAt).not.toBeNull();
    expect(sub().discounts).toEqual([]);
  });

  it("via the sweep, too", async () => {
    await runReferralRewards(NOW);
    fake.renew("sub_ref", { finalize: true });
    await runReferralRewards(fromSeconds(fake.clock));
    expect(await reward()).toMatchObject({ status: "running", freePlan: "crew" });
    expect((await reward()).invoiceFinalAt).not.toBeNull();
  });

  it("a plan change on Stripe's page while booked: the free plan is one above what renews", async () => {
    await runReferralRewards(NOW);
    fake.advance(10 * DAY);
    const { debit } = fake.portalChange("sub_ref", PRICE.crew);
    await webhook(fromSeconds(fake.clock), "crew");
    const inv = fake.renew("sub_ref");
    await webhook(fromSeconds(fake.clock), "crew");
    const row = await reward();
    expect(row).toMatchObject({ status: "running", paidPlan: "crew", freePlan: "company" });
    expect(row.adminFlag).toBeNull(); // the plan line is fully free
    // The proration for the change is charged as normal (Stripe applied our coupon to it).
    const prorations = inv.lines.data.filter(
      (l) => l.parent?.invoice_item_details?.invoice_item === debit.id,
    );
    expect(prorations).toHaveLength(1);
    expect(inv.lines.data[0]!.amount).toBe(19_900);
  });

  it("Stripe used it on another kind of invoice: failed, for Davi to check", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runReferralRewards(NOW);
    const inv = fake.renew("sub_ref");
    inv.billing_reason = "subscription_update";
    await runReferralRewards(fromSeconds(fake.clock));
    expect(await reward()).toMatchObject({ status: "failed", lastErrorCode: "used_early" });
  });
});

describe("a booked month that doesn't happen goes back to waiting", () => {
  it("a renewal that skipped it: flag, Activity, booked again, free at the following renewal", async () => {
    await runReferralRewards(NOW);
    fake.dropDiscount("sub_ref");
    const first = fake.renew("sub_ref", { finalize: true });
    expect(first.total).toBe(9_900);
    await runReferralRewards(fromSeconds(fake.clock));
    expect(await reward()).toMatchObject({
      status: "pending",
      adminFlag: "renewed_without_discount",
      stripeSubscriptionId: null,
    });
    expect(await log()).toContainEqual([
      "referral_reward_returned",
      { why: "renewed_without" },
      "squared_away",
    ]);
    await runReferralRewards(fromSeconds(fake.clock + 60));
    expect((await reward()).status).toBe("scheduled");
    const second = fake.renew("sub_ref");
    await webhook(fromSeconds(fake.clock));
    expect((await reward()).status).toBe("running");
    expect(second.total).toBe(0);
  });

  it("removed in Stripe before any renewal: back to waiting, flagged", async () => {
    await runReferralRewards(NOW);
    fake.dropDiscount("sub_ref");
    // Waiting again does not immediately re-book in the same run (the flag tells Davi why).
    await webhook(later(DAY));
    const row = await reward();
    expect(row.adminFlag).toBe("discount_removed");
    expect(await log()).toContainEqual([
      "referral_reward_returned",
      { why: "discount_removed" },
      "squared_away",
    ]);
  });

  it("the account stops being on: our discount comes off (the promo stays), then back on", async () => {
    const promo = await addPromo();
    await runReferralRewards(NOW);
    await set({ status: "past_due" });
    await runReferralRewards(later(DAY));
    expect(await reward()).toMatchObject({ status: "pending", stripeDiscountId: null });
    expect(sub().discounts.map((d) => (d as Stripe.Discount).id)).toEqual([promo]);
    const detach = updates().at(-1)!;
    expect(detach.args[1]).toEqual({ discounts: [{ discount: promo }] });
    expect(String((detach.args[2] as { idempotencyKey: string }).idempotencyKey)).toMatch(
      /^referral-detach-/,
    );
    expect(await log()).toContainEqual([
      "referral_reward_returned",
      { why: "account_off" },
      "squared_away",
    ]);
    await set({ status: "active" });
    await runReferralRewards(later(2 * DAY));
    expect((await reward()).status).toBe("scheduled");
    expect(sub().discounts).toHaveLength(2);
  });

  it("the plan ends: back to waiting; a new plan books it on the new subscription", async () => {
    await runReferralRewards(NOW);
    sub().status = "canceled";
    await webhook(later(DAY), "solo", "canceled");
    expect(await reward()).toMatchObject({ status: "pending", stripeSubscriptionId: null });
    expect(await log()).toContainEqual([
      "referral_reward_returned",
      { why: "plan_ended" },
      "squared_away",
    ]);
    fake.addSubscription({ id: "sub_new", customer: "cus_ref", price: PRICE.solo });
    await set({ status: "setup_paid", stripeSubscriptionId: "sub_new" });
    await runReferralRewards(later(2 * DAY));
    expect(await reward()).toMatchObject({ status: "scheduled", stripeSubscriptionId: "sub_new" });
  });
});

// --- The end --------------------------------------------------------------------------------

describe("the end of a free month", () => {
  /** Three inboxes (the first created first) and a category on autopilot with a countdown. */
  async function crewSetup() {
    const ids: string[] = [];
    for (const [i, email] of ["rosa@gmail.com", "office@rosa.com", "van@rosa.com"].entries()) {
      const box = await saveConnectedMailbox(
        { id: w.id, plan: "company", freePlan: null, freePlanUntil: null },
        { email, refreshToken: "rt", grantedScopes: [] },
      );
      await database
        .update(mailboxes)
        .set({ createdAt: new Date(NOW.getTime() - (3 - i) * DAY) })
        .where(eq(mailboxes.id, box.id));
      ids.push(box.id);
    }
    await database
      .insert(rules)
      .values({ workspaceId: w.id, category: "scheduling", mode: "autopilot" });
    const [t] = await database
      .insert(threads)
      .values({ mailboxId: ids[0]!, gmailThreadId: "g1", inInbox: true, category: "scheduling" })
      .returning();
    const [d] = await database
      .insert(drafts)
      .values({
        threadId: t!.id,
        mailboxId: ids[0]!,
        toAddress: "dana@x.com",
        subject: "Re: Tuesday",
        body: "Tuesday works.",
        originalBody: "Tuesday works.",
        reason: "Confirms the time.",
        autoSendAt: later(40 * DAY),
      })
      .returning();
    return { ids, draftId: d!.id };
  }

  it("by our clock: features drop with no job; then one transaction does the rest", async () => {
    await startFreeMonth({ finalize: true });
    const { draftId } = await crewSetup();
    const row = await reward();
    const end = row.endsAt!;
    // At the end, with no job run at all, the plan that counts is back to Solo.
    const atEnd = await load();
    expect(effectivePlan(atEnd, end)).toBe("solo");
    expect(mailboxLimit(atEnd, end)).toBe(1);
    expect(accountLockReason(atEnd, end)).not.toBeNull();

    await runReferralRewards(end);
    expect(await reward()).toMatchObject({ status: "done" });
    expect(await load()).toMatchObject({ freePlan: null, freePlanUntil: null, plan: "solo" });
    expect((await database.select().from(rules))[0]!.mode).toBe("draft");
    const [d] = await database.select().from(drafts).where(eq(drafts.id, draftId));
    expect(d!.autoSendAt).toBeNull();
    const boxes = await database.select().from(mailboxes);
    expect(Object.fromEntries(boxes.map((b) => [b.email, [b.status, b.pausedReason]]))).toEqual({
      "rosa@gmail.com": ["active", null],
      "office@rosa.com": ["paused", "over_plan"],
      "van@rosa.com": ["paused", "over_plan"],
    });
    const actions = (await log()).map(([a, d]) => [a, d]);
    expect(actions).toEqual(
      expect.arrayContaining([
        ["autopilot_turned_off_plan", { count: 1 }],
        ["inboxes_paused_plan", { count: 2 }],
        ["referral_free_month_ended", { plan: "crew", backTo: "solo" }],
      ]),
    );
  });

  it("by Stripe's renewal, even with Stripe's clock a month ahead of ours", async () => {
    await startFreeMonth({ finalize: true });
    const row = await reward();
    // The app's clock is still early in the month; Stripe renews.
    const next = fake.renew("sub_ref", { finalize: true });
    expect(next.total).toBe(9_900);
    await webhook(new Date(row.startsAt!.getTime() + DAY));
    expect((await reward()).status).toBe("done");
    expect((await load()).freePlan).toBeNull();
  });

  it("Crew → a free Company month: autopilot stays on at the end", async () => {
    await set({ plan: "crew" });
    item().price = fake.price(PRICE.crew);
    await database
      .insert(rules)
      .values({ workspaceId: w.id, category: "scheduling", mode: "autopilot" });
    await startFreeMonth({ finalize: true });
    expect((await reward()).freePlan).toBe("company");
    await runReferralRewards((await reward()).endsAt!);
    expect((await reward()).status).toBe("done");
    expect((await database.select().from(rules))[0]!.mode).toBe("autopilot");
  });

  it("an invoice that never finalized: the coupon comes off at the end (others kept), flagged", async () => {
    const promo = await addPromo();
    await startFreeMonth({ finalize: "fails" });
    expect((await reward()).invoiceFinalAt).toBeNull();
    await runReferralRewards((await reward()).endsAt!);
    expect(await reward()).toMatchObject({ status: "done", adminFlag: "invoice_not_final" });
    expect(sub().discounts.map((d) => (d as Stripe.Discount).id)).toEqual([promo]);
    // No second free month at the next renewal.
    const next = fake.renew("sub_ref", { finalize: true });
    expect(next.lines.data[0]!.discount_amounts?.map((a) => a.amount)).toEqual([990]);
  });

  it("a running month ends even after referrals are switched off", async () => {
    await startFreeMonth({ finalize: true });
    delete process.env.FEATURE_REFERRALS;
    await runReferralRewards((await reward()).endsAt!);
    expect((await reward()).status).toBe("done");
  });

  it("the plan effects failing roll the end back; the next run completes it", async () => {
    await startFreeMonth({ finalize: true });
    for (const email of ["rosa@gmail.com", "office@rosa.com"])
      await saveConnectedMailbox(
        { id: w.id, plan: "company", freePlan: null, freePlanUntil: null },
        { email, refreshToken: "rt", grantedScopes: [] },
      );
    const end = (await reward()).endsAt!;
    // The inbox step fails (any update to a mailbox raises) inside the end's transaction.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await database.execute(
      sql.raw(`create or replace function fail_always() returns trigger as $$
        begin raise exception 'boom'; end $$ language plpgsql`),
    );
    await database.execute(
      sql.raw(
        `create trigger fail_always before update on mailboxes for each row execute function fail_always()`,
      ),
    );
    const r = await runReferralRewards(end);
    expect(r.failed).toBe(1);
    expect(errors).toHaveBeenCalledWith("referral_reconcile_failed", {
      workspaceId: w.id,
      error: expect.any(String),
    });
    expect((await reward()).status).toBe("running");
    expect((await load()).freePlan).toBe("crew");
    await database.execute(sql.raw(`drop trigger fail_always on mailboxes`));
    await runReferralRewards(end);
    expect((await reward()).status).toBe("done");
    expect((await database.select().from(mailboxes)).map((m) => m.status).sort()).toEqual([
      "active",
      "paused",
    ]);
  });
});

// --- Keep / Go back -------------------------------------------------------------------------

describe("Keep / Go back (the owner's tap)", () => {
  const keep = (at: Date, over: { plan?: PlanId; priceCents?: number; rewardId?: string } = {}) =>
    keepFreePlan(
      w.id,
      {
        rewardId: over.rewardId ?? rewardId,
        plan: over.plan ?? "crew",
        priceCents: over.priceCents ?? pricing.plans.crew.amountCents,
      },
      at,
    );
  const goBack = (at: Date) => goBackToPaidPlan(w.id, { rewardId }, at);
  const mid = async () => new Date((await reward()).startsAt!.getTime() + 5 * DAY);
  const planWrites = () => updates().filter((u) => "items" in (u.args[1] as object));

  it("Keep: one plan change, no proration, nothing invoiced; nothing drops at the end", async () => {
    await startFreeMonth({ finalize: true });
    fake.writes.length = 0;
    const at = await mid();
    const r = await keep(at);
    expect(r).toMatchObject({ status: "kept", plan: "crew", priceCents: 19_900 });
    const [u] = planWrites();
    expect(u!.args).toEqual([
      "sub_ref",
      { items: [{ id: item().id, price: PRICE.crew }], proration_behavior: "none" },
      { idempotencyKey: `referral-plan-${rewardId}-v1` },
    ]);
    expect(writes()).toEqual(["subscriptions.update"]);
    expect(fake.invoices.size).toBe(1); // only the free month's own invoice
    expect(await load()).toMatchObject({ plan: "crew" });
    expect(await reward()).toMatchObject({ keptPriceCents: 19_900 });
    expect(await log()).toContainEqual([
      "referral_plan_kept",
      {
        plan: "crew",
        priceCents: 19_900,
        firstChargeAt: (await reward()).endsAt!.toISOString(),
      },
      "owner",
    ]);
    await runReferralRewards((await reward()).endsAt!);
    expect(effectivePlan(await load(), later(90 * DAY))).toBe("crew");
    // The next renewal charges Crew from the end of the free month.
    expect(fake.renew("sub_ref").total).toBe(19_900);
  });

  it("Keep → Go back → Keep → Go back: four writes, ending on the original price", async () => {
    await startFreeMonth({ finalize: true });
    fake.writes.length = 0;
    const at = await mid();
    expect((await keep(at)).status).toBe("kept");
    expect((await goBack(new Date(at.getTime() + 3 * 60_000))).status).toBe("went_back");
    expect((await keep(new Date(at.getTime() + 6 * 60_000))).status).toBe("kept");
    expect((await goBack(new Date(at.getTime() + 9 * 60_000))).status).toBe("went_back");
    expect(planWrites()).toHaveLength(4);
    expect(new Set(planWrites().map((u) => JSON.stringify(u.args[2]))).size).toBe(4);
    expect(item().price.id).toBe(PRICE.solo);
    expect(await load()).toMatchObject({ plan: "solo" });
    expect((await reward()).keptAt).toBeNull();
    expect(fake.renew("sub_ref").total).toBe(9_900);
  });

  it("Go back restores a grandfathered price, and Keep works from it", async () => {
    fake.addPrice({ id: "price_solo_old", lookup_key: "sa_solo_7900_month", unit_amount: 7_900 });
    item().price = fake.price("price_solo_old");
    await startFreeMonth({ finalize: true });
    expect(await reward()).toMatchObject({ paidPriceId: "price_solo_old", paidPriceCents: 7_900 });
    const at = await mid();
    expect((await keep(at)).status).toBe("kept");
    expect((await goBack(new Date(at.getTime() + 3 * 60_000))).status).toBe("went_back");
    expect(item().price.id).toBe("price_solo_old");
  });

  describe("refusals change nothing in Stripe", () => {
    const refused: [string, () => Promise<unknown>, string][] = [
      [
        "a price other than the one shown",
        async () => keep(await mid(), { priceCents: 9_900 }),
        "price_changed",
      ],
      [
        "a plan other than the free one",
        async () => keep(await mid(), { plan: "company" }),
        "price_changed",
      ],
      [
        "within an hour of the end",
        async () => keep(new Date((await reward()).endsAt!.getTime() - 30 * 60_000)),
        "not_offered",
      ],
      [
        "Stripe already renewed",
        async () => {
          item().current_period_start = Math.floor((await reward()).endsAt!.getTime() / 1000);
          return keep(await mid());
        },
        "ended",
      ],
      [
        "the plan is set to end",
        async () => {
          sub().cancel_at_period_end = true;
          return keep(await mid());
        },
        "set_to_end",
      ],
      [
        "a schedule on the subscription",
        async () => {
          sub().schedule = "sub_sched_1";
          return keep(await mid());
        },
        "schedule",
      ],
      [
        "another workspace's reward",
        async () => {
          const other = await ensureUserAndWorkspace({ email: "eve@gmail.com" });
          return keepFreePlan(
            other.workspace.id,
            { rewardId, plan: "crew", priceCents: 19_900 },
            await mid(),
          );
        },
        "not_offered",
      ],
      [
        "the claim held by another tap",
        async () => {
          const at = await mid();
          await database
            .update(referralCredits)
            .set({ claimedAt: at })
            .where(eq(referralCredits.id, rewardId));
          return keep(new Date(at.getTime() + 30_000));
        },
        "busy",
      ],
      [
        "a read-only account",
        async () => {
          await set({ status: "past_due" });
          return keep(await mid());
        },
        "not_offered",
      ],
      [
        "Company → Company",
        async () => {
          await database
            .update(referralCredits)
            .set({ paidPlan: "company", freePlan: "company" })
            .where(eq(referralCredits.id, rewardId));
          await set({ plan: "company" });
          return keep(await mid(), { plan: "company", priceCents: 29_900 });
        },
        "not_offered",
      ],
    ];
    for (const [name, act, status] of refused) {
      it(name, async () => {
        await startFreeMonth({ finalize: true });
        fake.writes.length = 0;
        expect(await act()).toMatchObject({ status });
        expect(planWrites()).toEqual([]);
        expect(item().price.id).toBe(PRICE.solo);
      });
    }
  });

  it("Stripe not answering refuses the tap (and releases the claim)", async () => {
    await startFreeMonth({ finalize: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const at = await mid();
    fake.failNext("subscriptions.update", stripeErrors.connection());
    expect(await keep(at)).toEqual({ status: "stripe_down" });
    expect((await reward()).claimedAt).toBeNull();
    expect((await keep(new Date(at.getTime() + 1000))).status).toBe("kept");
  });

  it("a late, older event after Keep can't put the plan back (fresh read)", async () => {
    await startFreeMonth({ finalize: true });
    const at = await mid();
    await keep(at);
    // The discount-added event from weeks ago arrives now, with Solo in its snapshot.
    await webhook(new Date(at.getTime() + 60_000), "solo");
    expect((await load()).plan).toBe("crew");
  });

  it("a plan change on Stripe's page that the owner didn't tap here is never recorded as theirs", async () => {
    await startFreeMonth({ finalize: true });
    fake.portalChange("sub_ref", PRICE.crew);
    await runReferralRewards(await mid());
    const row = await reward();
    expect(row.keptAt).not.toBeNull();
    expect(row.adminFlag).toBe("plan_changed_in_free_month");
    expect((await log()).map(([a]) => a)).not.toContain("referral_plan_kept");
  });
});

// --- Backstop -------------------------------------------------------------------------------

describe("backstop: no charge for days of the free month", () => {
  for (const mode of ["flexible", "classic"] as const) {
    it(`a plan change on Stripe's page during the month (${mode}): the charge for free days goes`, async () => {
      sub().billing_mode = { type: mode, flexible: null };
      await startFreeMonth({ finalize: true });
      fake.advance(10 * DAY);
      const { credit, debit } = fake.portalChange("sub_ref", PRICE.crew);
      expect(credit).toBeNull(); // nothing was paid for the free days, so no credit
      expect(debit.amount).toBeGreaterThan(0);
      await webhook(fromSeconds(fake.clock), "crew");
      expect(fake.invoiceItems.has(debit.id)).toBe(false);
      expect((await reward()).adminFlag).toBe("plan_changed_in_free_month");
      // The end: Crew from then on, and nothing for the free days.
      const next = fake.renew("sub_ref", { finalize: true });
      expect(next.total).toBe(19_900);
      expect(next.lines.data).toHaveLength(1);
    });
  }

  it("credits are left alone", async () => {
    await startFreeMonth({ finalize: true });
    const credit = fake.addInvoiceItem({
      customer: "cus_ref",
      amount: -500,
      proration: true,
      parent: {
        type: "subscription_details",
        subscription_details: { subscription: "sub_ref", subscription_item: item().id },
      },
      period: { start: item().current_period_start, end: item().current_period_end },
    });
    await runReferralRewards(
      await (async () => new Date((await reward()).startsAt!.getTime() + DAY))(),
    );
    expect(fake.invoiceItems.has(credit.id)).toBe(true);
  });
});

// --- Two referrals, webhook resilience, guardrail -------------------------------------------

describe("two referrals: one free month at a time, with a paid month between", () => {
  it("free, paid, free", async () => {
    const second = await earn("test", later(60_000));
    await startFreeMonth({ finalize: true });
    // While the first runs, the second waits.
    await runReferralRewards(new Date((await reward()).startsAt!.getTime() + DAY));
    expect((await reward(second)).status).toBe("pending");
    // Stripe renews: the first ends and the second is booked for the renewal after.
    const paid = fake.renew("sub_ref", { finalize: true });
    await webhook(fromSeconds(fake.clock));
    expect((await reward()).status).toBe("done");
    expect((await reward(second)).status).toBe("scheduled");
    expect(paid.total).toBe(9_900);
    const free = fake.renew("sub_ref");
    await webhook(fromSeconds(fake.clock));
    expect((await reward(second)).status).toBe("running");
    expect(free.total).toBe(0);
  });

  it("ended by our clock before Stripe renews: the next one waits for that renewal", async () => {
    const second = await earn("test", later(60_000));
    await startFreeMonth({ finalize: true });
    await runReferralRewards((await reward()).endsAt!);
    expect((await reward()).status).toBe("done");
    expect((await reward(second)).status).toBe("pending");
    expect(fake.renew("sub_ref", { finalize: true }).total).toBe(9_900);
  });
});

describe("the webhook never fails on a side feature", () => {
  it("an invoice read failing inside the reward step: 'applied', status and plan land", async () => {
    await runReferralRewards(NOW);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.failNext("invoices.list", stripeErrors.api());
    sub().items.data[0]!.price = fake.price(PRICE.crew);
    sub().status = "past_due";
    expect(await webhook(later(DAY))).toBe("applied");
    expect(await load()).toMatchObject({ status: "past_due", plan: "crew" });
    expect(errors).toHaveBeenCalledWith("referral_reconcile_failed", {
      workspaceId: w.id,
      error: "Error",
    });
  });
});

describe("GUARDRAIL: nothing ever charges more without the owner's tap", () => {
  it("through every state, no write outside Keep raises a price", async () => {
    const all: Call[] = [];
    const take = () => {
      all.push(...fake.writes);
      fake.writes.length = 0;
    };
    await earn("test", later(60_000));
    await addPromo();
    // Booked, then past due (detached), back on (booked again).
    await runReferralRewards(NOW);
    await set({ status: "past_due" });
    await runReferralRewards(later(DAY));
    await set({ status: "active" });
    await runReferralRewards(later(2 * DAY));
    take();
    // A dropped discount and a renewal that skipped it.
    fake.dropDiscount("sub_ref");
    fake.renew("sub_ref", { finalize: true });
    await runReferralRewards(fromSeconds(fake.clock));
    await runReferralRewards(fromSeconds(fake.clock + 60));
    take();
    // The free month, a finalization failure, a plan change on Stripe's page, the end.
    fake.renew("sub_ref", { finalize: "fails" });
    await webhook(fromSeconds(fake.clock));
    fake.advance(5 * DAY);
    fake.portalChange("sub_ref", PRICE.crew);
    all.push(...fake.writes.filter((c) => c.method === "portal.subscription_update"));
    fake.writes.length = 0;
    await webhook(fromSeconds(fake.clock), "crew");
    fake.renew("sub_ref", { finalize: true });
    await webhook(fromSeconds(fake.clock), "crew");
    // The second referral, after a paid month.
    fake.renew("sub_ref", { finalize: true });
    await webhook(fromSeconds(fake.clock), "crew");
    take();
    // Cancel and re-checkout.
    sub().status = "canceled";
    await webhook(fromSeconds(fake.clock), "crew", "canceled");
    take();

    const ours = all.filter((c) => c.method !== "portal.subscription_update");
    const methods = new Set(ours.map((c) => c.method));
    for (const m of methods)
      expect(["coupons.create", "subscriptions.update", "invoiceItems.del"]).toContain(m);
    for (const u of ours.filter((c) => c.method === "subscriptions.update"))
      expect(Object.keys(u.args[1] as object)).toEqual(["discounts"]);
  });

  it("static: only Keep / Go back change a subscription's items; no schedules or balance credits", () => {
    const src = readFileSync("src/server/referrals.ts", "utf8");
    expect(src.match(/items: \[\{ id: item\.id, price: target \}\]/g)).toHaveLength(1);
    expect(src.indexOf("items: [{ id: item.id")).toBeGreaterThan(
      src.indexOf("async function changePlan"),
    );
    for (const file of ["src/server/referrals.ts", "src/server/billing.ts"]) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/subscriptionSchedules|createBalanceTransaction/);
    }
  });
});
