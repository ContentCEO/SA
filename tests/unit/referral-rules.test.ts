import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { pricing, type PlanId } from "@/config/pricing";
import type { Workspace } from "@/db/schema";
import { EARN_THRESHOLD } from "@/server/autopilot";
import { planLookupKey } from "@/server/billing-rules";
import {
  addInboxFreeMonthNote,
  autopilotFreeMonthLine,
  billedPlanFreeLine,
  canAttach,
  chargesForFreeDays,
  classifyStripeError,
  couponOf,
  effectivePlan,
  endChangeLines,
  endChanges,
  freeMonthBanner,
  freeMonthRunning,
  freeMonthSummary,
  goBackCopy,
  goBackOffer,
  idOf,
  inboxPausedSendLine,
  invoiceSubscriptionId,
  invoiceUsed,
  isReferralDiscount,
  keepCopy,
  keepOffer,
  lineDiscountedBy,
  linePriceId,
  pausedDraftsLine,
  pausedInboxCopy,
  planChangesWaitLine,
  planIncludes,
  planLine,
  planLineFullyFree,
  portalSchedulesDowngrades,
  reconnectRefusedLine,
  REFERRAL_COUPON_NAME,
  REFERRAL_COUPON_PREFIX,
  referralCouponId,
  rewardStatusLine,
  shareCardCopy,
  shortDate,
  stripePageShowsLine,
  type AttachContext,
} from "@/server/referral-rules";

const NOW = new Date("2026-10-16T15:00:00Z");
const DAY = 86_400_000;
const IN = (days: number) => new Date(NOW.getTime() + days * DAY);
const sec = (d: Date) => Math.floor(d.getTime() / 1000);

// --- Effective plan -------------------------------------------------------------------------

describe("effectivePlan", () => {
  const w = (
    plan: PlanId | null,
    freePlan: PlanId | null = null,
    freePlanUntil: Date | null = null,
  ) => ({ plan, freePlan, freePlanUntil });

  it("is the free plan only while the month runs and only when it is higher", () => {
    expect(effectivePlan(w("solo", "crew", IN(10)), NOW)).toBe("crew");
    expect(effectivePlan(w("crew", "company", IN(10)), NOW)).toBe("company");
    // Ends exactly at free_plan_until, with no job run.
    expect(effectivePlan(w("solo", "crew", NOW), NOW)).toBe("solo");
    expect(effectivePlan(w("solo", "crew", IN(-1)), NOW)).toBe("solo");
    // Never lowers: a kept or higher billed plan wins.
    expect(effectivePlan(w("crew", "crew", IN(10)), NOW)).toBe("crew");
    expect(effectivePlan(w("company", "crew", IN(10)), NOW)).toBe("company");
    expect(effectivePlan(w("solo"), NOW)).toBe("solo");
    expect(effectivePlan(w(null), NOW)).toBeNull();
    // A free plan without an end date never counts.
    expect(effectivePlan(w("solo", "crew", null), NOW)).toBe("solo");
    expect(freeMonthRunning(w("solo", "crew", IN(1)), NOW)).toBe(true);
    expect(freeMonthRunning(w("solo", "crew", IN(-1)), NOW)).toBe(false);
  });
});

// --- Stripe shapes --------------------------------------------------------------------------

const discount = (id: string, coupon: string | { id: string } | null) =>
  ({
    id,
    object: "discount",
    source: { coupon, type: "coupon" },
    start: sec(NOW),
  }) as unknown as Stripe.Discount;
const deleted = (id: string, coupon: string) =>
  ({ ...discount(id, coupon), deleted: true }) as unknown as Stripe.DeletedDiscount;

describe("Stripe shape helpers", () => {
  it("reads ids and coupons from strings, discounts and deleted discounts", () => {
    expect(idOf("di_1")).toBe("di_1");
    expect(idOf(discount("di_2", "c"))).toBe("di_2");
    expect(idOf(deleted("di_3", "c"))).toBe("di_3");
    expect(couponOf("di_1")).toBeNull(); // not expanded
    expect(couponOf(discount("di_2", "sa_ref_x"))).toBe("sa_ref_x");
    expect(couponOf(discount("di_2", { id: "sa_ref_y" }))).toBe("sa_ref_y");
    expect(couponOf(deleted("di_3", "sa_ref_z"))).toBe("sa_ref_z");
    expect(couponOf(discount("di_4", null))).toBeNull();
    expect(isReferralDiscount(discount("di_5", referralCouponId("abc")))).toBe(true);
    expect(isReferralDiscount(discount("di_6", "SPRING10"))).toBe(false);
    expect(isReferralDiscount("di_7")).toBe(false);
  });

  it("the coupon id is deterministic and the name names no plan", () => {
    expect(referralCouponId("r1")).toBe(`${REFERRAL_COUPON_PREFIX}r1`);
    expect(REFERRAL_COUPON_NAME).toBe("Referral thanks: this month is free");
    for (const p of Object.values(pricing.plans))
      expect(REFERRAL_COUPON_NAME).not.toContain(p.name);
  });

  const line = (over: Record<string, unknown>) =>
    ({
      id: "il_1",
      amount: 9_900,
      discount_amounts: [],
      period: { start: sec(IN(10)), end: sec(IN(40)) },
      pricing: { type: "price_details", price_details: { price: "price_solo", product: "p" } },
      subscription: "sub_1",
      parent: {
        type: "subscription_item_details",
        subscription_item_details: {
          subscription: "sub_1",
          subscription_item: "si_1",
          proration: false,
          invoice_item: null,
          proration_details: null,
        },
        invoice_item_details: null,
      },
      ...over,
    }) as unknown as Stripe.InvoiceLineItem;
  const proration = line({
    id: "il_p",
    amount: 5_000,
    parent: {
      type: "invoice_item_details",
      invoice_item_details: {
        invoice_item: "ii_1",
        proration: true,
        subscription: "sub_1",
        proration_details: null,
      },
      subscription_item_details: null,
    },
  });

  it("finds the plan line (never a proration, never another subscription's)", () => {
    const subProration = line({
      id: "il_sp",
      parent: {
        type: "subscription_item_details",
        subscription_item_details: { subscription: "sub_1", proration: true },
      },
    });
    const other = line({
      id: "il_o",
      parent: {
        type: "subscription_item_details",
        subscription_item_details: { subscription: "sub_2", proration: false },
      },
    });
    const plan = line({});
    expect(planLine([proration, subProration, other, plan], "sub_1")?.id).toBe("il_1");
    expect(planLine([proration, other], "sub_1")).toBeNull();
    expect(linePriceId(plan)).toBe("price_solo");
    expect(
      linePriceId(
        line({
          pricing: { price_details: { price: { id: "price_obj" } } },
        }) as Stripe.InvoiceLineItem,
      ),
    ).toBe("price_obj");
  });

  it("knows whether an invoice used a discount, and whether the plan line is fully free", () => {
    const used = line({ discount_amounts: [{ amount: 9_900, discount: "di_ours" }] });
    const inv = (over: Record<string, unknown>) =>
      ({
        discounts: [],
        total_discount_amounts: [],
        lines: { data: [] },
        parent: { subscription_details: { subscription: "sub_1" } },
        ...over,
      }) as unknown as Stripe.Invoice;
    expect(invoiceUsed(inv({ discounts: ["di_ours"] }), "di_ours")).toBe(true);
    expect(invoiceUsed(inv({ discounts: [deleted("di_ours", "sa_ref_1")] }), "di_ours")).toBe(true);
    expect(
      invoiceUsed(inv({ total_discount_amounts: [{ amount: 1, discount: "di_ours" }] }), "di_ours"),
    ).toBe(true);
    expect(invoiceUsed(inv({ lines: { data: [used] } }), "di_ours")).toBe(true);
    expect(invoiceUsed(inv({ discounts: ["di_other"] }), "di_ours")).toBe(false);
    expect(invoiceSubscriptionId(inv({}))).toBe("sub_1");
    expect(invoiceSubscriptionId(inv({ parent: null }))).toBeNull();

    expect(lineDiscountedBy(used, "di_ours")).toBe(9_900);
    expect(planLineFullyFree(used, "di_ours")).toBe(true);
    const partly = line({ discount_amounts: [{ amount: 4_000, discount: "di_ours" }] });
    expect(planLineFullyFree(partly, "di_ours")).toBe(false);
    expect(planLineFullyFree(used, "di_other")).toBe(false);
  });

  it("removes only positive prorations for this subscription inside the free days", () => {
    const item = (id: string, over: Record<string, unknown>) =>
      ({
        id,
        amount: 3_000,
        proration: true,
        invoice: null,
        period: { start: sec(IN(5)), end: sec(IN(20)) },
        parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } },
        ...over,
      }) as unknown as Stripe.InvoiceItem;
    const items = [
      item("ii_in", {}),
      item("ii_credit", { amount: -3_000 }),
      item("ii_not_proration", { proration: false }),
      item("ii_other_sub", {
        parent: { type: "subscription_details", subscription_details: { subscription: "sub_2" } },
      }),
      item("ii_before", { period: { start: sec(IN(-20)), end: sec(IN(0)) } }),
      item("ii_after", { period: { start: sec(IN(30)), end: sec(IN(40)) } }),
      item("ii_invoiced", { invoice: "in_1" }),
      item("ii_overlaps_end", { period: { start: sec(IN(25)), end: sec(IN(35)) } }),
    ];
    expect(chargesForFreeDays(items, "sub_1", NOW, IN(30))).toEqual(["ii_in", "ii_overlaps_end"]);
  });

  it("knows when Stripe's billing page schedules downgrades", () => {
    const cfg = (enabled: boolean, conditions: unknown[]) =>
      ({
        features: { subscription_update: { enabled, schedule_at_period_end: { conditions } } },
      }) as unknown as Stripe.BillingPortal.Configuration;
    expect(portalSchedulesDowngrades(cfg(true, []))).toBe(false);
    expect(portalSchedulesDowngrades(cfg(true, [{ type: "decreasing_item_amount" }]))).toBe(true);
    expect(portalSchedulesDowngrades(cfg(false, [{ type: "decreasing_item_amount" }]))).toBe(false);
  });
});

// --- canAttach ------------------------------------------------------------------------------

describe("canAttach", () => {
  const on = (over: Partial<Workspace> = {}) => ({
    status: "active" as Workspace["status"],
    evaluationEndsAt: null,
    setupPaidVia: "stripe" as Workspace["setupPaidVia"],
    ...over,
  });
  const sub = (over: Record<string, unknown> = {}) =>
    ({
      status: "active",
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: null,
      items: { data: [{ price: { lookup_key: planLookupKey("solo") } }] },
      discounts: [],
      ...over,
    }) as unknown as Stripe.Subscription;
  const ctx = (over: Partial<AttachContext> = {}): AttachContext => ({
    rewardOn: true,
    rowMode: "live",
    keyMode: "live",
    otherFreeMonth: false,
    portalSchedulesDowngrades: false,
    ...over,
  });

  it("attaches when everything holds (a promo discount is fine)", () => {
    expect(canAttach(on(), sub(), ctx(), NOW)).toEqual([]);
    expect(canAttach(on({ status: "setup_paid" }), sub(), ctx(), NOW)).toEqual([]);
    expect(
      canAttach(on(), sub({ discounts: [discount("di_promo", "SPRING10")] }), ctx(), NOW),
    ).toEqual([]);
  });

  it.each([
    ["reward_off", on(), sub(), ctx({ rewardOn: false })],
    ["other_mode", on(), sub(), ctx({ rowMode: "test" })],
    ["other_mode", on(), sub(), ctx({ keyMode: null })],
    ["account_off", on({ status: "past_due" }), sub(), ctx()],
    ["account_off", on({ status: "paused" }), sub(), ctx()],
    ["account_off", on({ status: "canceled" }), sub(), ctx()],
    ["account_off", on({ status: "evaluating", evaluationEndsAt: IN(1) }), sub(), ctx()],
    ["account_off", on({ setupPaidVia: "house" }), sub(), ctx()],
    ["account_off", on({ setupPaidVia: null }), sub(), ctx()],
    ["another_free_month", on(), sub(), ctx({ otherFreeMonth: true })],
    ["portal_schedules_downgrades", on(), sub(), ctx({ portalSchedulesDowngrades: true })],
    ["portal_schedules_downgrades", on(), sub(), ctx({ portalSchedulesDowngrades: null })],
    ["no_subscription", on(), null, ctx()],
    ["subscription_not_active", on(), sub({ status: "past_due" }), ctx()],
    ["set_to_end", on(), sub({ cancel_at_period_end: true }), ctx()],
    ["set_to_end", on(), sub({ cancel_at: sec(IN(5)) }), ctx()],
    ["schedule", on(), sub({ schedule: "sub_sched_1" }), ctx()],
    ["not_one_item", on(), sub({ items: { data: [] } }), ctx()],
    [
      "unknown_price",
      on(),
      sub({ items: { data: [{ price: { lookup_key: "hand_made" } }] } }),
      ctx(),
    ],
    ["discounts_unreadable", on(), sub({ discounts: ["di_1"] }), ctx()],
    [
      "referral_discount_on",
      on(),
      sub({ discounts: [discount("di_ref", referralCouponId("x"))] }),
      ctx(),
    ],
    [
      "too_many_discounts",
      on(),
      sub({ discounts: Array.from({ length: 20 }, (_, i) => discount(`di_${i}`, `c${i}`)) }),
      ctx(),
    ],
  ] as const)("waits: %s", (reason, w, s, c) => {
    expect(canAttach(w, s, c, NOW)).toContain(reason);
  });
});

// --- Keep / Go back -------------------------------------------------------------------------

describe("keepOffer / goBackOffer", () => {
  const w = (over: Partial<Workspace> = {}) => ({
    status: "active" as Workspace["status"],
    evaluationEndsAt: null,
    setupPaidVia: "stripe" as Workspace["setupPaidVia"],
    plan: "solo" as PlanId | null,
    stripeCancelAt: null as Date | null,
    ...over,
  });
  const r = (over: Record<string, unknown> = {}) => ({
    status: "running" as const,
    endsAt: IN(10),
    freePlan: "crew" as PlanId | null,
    paidPlan: "solo" as PlanId | null,
    paidPriceId: "price_solo_old",
    paidPriceCents: 9_900 as number | null,
    ...over,
  });

  it("offers Keep at today's config price, with the first charge at the end", () => {
    expect(keepOffer(w(), r(), NOW)).toEqual({
      plan: "crew",
      priceCents: pricing.plans.crew.amountCents,
      firstChargeAt: IN(10),
    });
    expect(keepOffer(w({ status: "setup_paid" }), r(), NOW)?.plan).toBe("crew");
  });

  it("never offers Keep for Company → Company, after a Keep, or near/after the end", () => {
    expect(
      keepOffer(w({ plan: "company" }), r({ freePlan: "company", paidPlan: "company" }), NOW),
    ).toBeNull();
    expect(keepOffer(w({ plan: "crew" }), r(), NOW)).toBeNull();
    expect(keepOffer(w(), r({ endsAt: new Date(NOW.getTime() + 59 * 60_000) }), NOW)).toBeNull();
    expect(
      keepOffer(w(), r({ endsAt: new Date(NOW.getTime() + 61 * 60_000) }), NOW),
    ).not.toBeNull();
    expect(keepOffer(w(), r({ endsAt: IN(-1) }), NOW)).toBeNull();
  });

  it.each([
    ["not running", w(), r({ status: "scheduled" })],
    ["past due", w({ status: "past_due" }), r()],
    ["paused", w({ status: "paused" }), r()],
    ["setup not really paid", w({ setupPaidVia: null }), r()],
    ["set to end", w({ stripeCancelAt: IN(10) }), r()],
  ] as const)("offers neither while %s", (_why, ws, rs) => {
    expect(keepOffer(ws, rs, NOW)).toBeNull();
    expect(goBackOffer({ ...ws, plan: "crew" }, rs, NOW)).toBeNull();
  });

  it("offers Go back only after a Keep, to exactly the price paid before", () => {
    expect(goBackOffer(w(), r(), NOW)).toBeNull(); // not kept
    expect(goBackOffer(w({ plan: "crew" }), r(), NOW)).toEqual({
      plan: "solo",
      priceCents: 9_900,
      at: IN(10),
    });
    // A grandfathered price stays the price.
    expect(goBackOffer(w({ plan: "crew" }), r({ paidPriceCents: 7_900 }), NOW)?.priceCents).toBe(
      7_900,
    );
    expect(goBackOffer(w({ plan: "crew" }), r({ paidPriceId: null }), NOW)).toBeNull();
    expect(
      goBackOffer(w({ plan: "company" }), r({ freePlan: "company", paidPlan: "company" }), NOW),
    ).toBeNull();
  });
});

// --- Stripe errors --------------------------------------------------------------------------

describe("classifyStripeError", () => {
  const err = (type: string, code?: string, statusCode?: number) => ({ type, code, statusCode });
  const invalid = err("StripeInvalidRequestError", "parameter_invalid", 400);
  const missing = err("StripeInvalidRequestError", "resource_missing", 404);
  const exists = err("StripeInvalidRequestError", "resource_already_exists", 400);
  const idem = err("StripeIdempotencyError", undefined, 400);
  const auth = err("StripeAuthenticationError", undefined, 401);
  const conn = err("StripeConnectionError");
  const api = err("StripeAPIError", undefined, 500);
  const rate = err("StripeRateLimitError", "rate_limit", 429);

  it("coupons: already made is fine; a refusal is permanent; blips are transient", () => {
    expect(classifyStripeError("coupon_create", exists)).toBe("ok");
    expect(classifyStripeError("coupon_create", invalid)).toBe("permanent");
    for (const e of [conn, api, rate, auth, new TypeError("x")])
      expect(classifyStripeError("coupon_create", e)).toBe("transient");
  });

  it("subscription writes: any 4xx means read again; blips are transient", () => {
    for (const op of ["attach", "detach", "strip", "plan_change"] as const) {
      for (const e of [invalid, missing, idem, auth])
        expect(classifyStripeError(op, e)).toBe("recheck");
      for (const e of [conn, api, rate, null]) expect(classifyStripeError(op, e)).toBe("transient");
    }
  });

  it("deleting a charge that's already gone is fine", () => {
    expect(classifyStripeError("invoice_item_delete", missing)).toBe("ok");
    for (const e of [invalid, conn, api])
      expect(classifyStripeError("invoice_item_delete", e)).toBe("transient");
  });
});

// --- End changes and copy -------------------------------------------------------------------

describe("endChanges", () => {
  it("names only what will change, from live counts", () => {
    expect(endChanges({ to: "solo", countedInboxes: 3, autopilotCategoriesOn: 2 })).toEqual({
      to: "solo",
      limit: 1,
      counted: 3,
      inboxesPause: 2,
      autopilotTurnsOff: true,
    });
    expect(endChanges({ to: "solo", countedInboxes: 1, autopilotCategoriesOn: 0 })).toMatchObject({
      inboxesPause: 0,
      autopilotTurnsOff: false,
    });
    // Crew → Company ending keeps autopilot.
    expect(endChanges({ to: "crew", countedInboxes: 5, autopilotCategoriesOn: 3 })).toMatchObject({
      inboxesPause: 2,
      autopilotTurnsOff: false,
    });
  });
});

describe("copy", () => {
  const TZ = "America/Los_Angeles";
  const NOV15 = new Date("2026-11-15T17:00:00Z");

  it("dates are short and in the owner's time zone (Eastern when unknown)", () => {
    expect(shortDate(NOV15, TZ)).toBe("Nov 15");
    // 03:00 UTC on Nov 16 is still Nov 15 on the west coast.
    expect(shortDate(new Date("2026-11-16T03:00:00Z"), TZ)).toBe("Nov 15");
    expect(shortDate(new Date("2026-11-16T03:00:00Z"), "Not/AZone")).toBe("Nov 15");
    expect(shortDate(new Date("2026-11-16T06:00:00Z"), null)).toBe("Nov 16");
  });

  it("§4.1 the share card, per plan (Q4: a free Company month includes priority support)", () => {
    const solo = shareCardCopy({ plan: "solo", status: "active" }, EARN_THRESHOLD);
    expect(solo.title).toBe("Share Squared Away");
    expect(solo.intro).toContain("your next month is free, on the plan above yours.");
    expect(solo.plan).toBe(
      `You're on Solo, so that's a free month of Crew: up to 3 inboxes, and autopilot for the kinds of email you've okayed ${EARN_THRESHOLD} times.`,
    );
    expect(solo.setup).toBeNull();
    expect(shareCardCopy({ plan: "solo", status: "setup_paid" }, EARN_THRESHOLD).setup).toBe(
      "Autopilot starts once your setup call is done.",
    );
    expect(shareCardCopy({ plan: "crew", status: "active" }, EARN_THRESHOLD).plan).toBe(
      "You're on Crew, so that's a free month of Company: up to 10 inboxes and priority support.",
    );
    expect(shareCardCopy({ plan: "company", status: "active" }, EARN_THRESHOLD).plan).toBe(
      "You're on Company, so that's a month of Company free.",
    );
    expect(shareCardCopy({ plan: null, status: "evaluating" }, EARN_THRESHOLD).plan).toBe(
      "Once you're on a plan, it's a free month of the plan above yours.",
    );
    expect(solo.after).toContain("We never charge you more unless you tap Keep.");
    expect(solo.after).toContain("One free month at a time, one per new business.");
  });

  it("§4.2 status lines for an earned month that hasn't started", () => {
    const ws = (over: Partial<Workspace> = {}) => ({
      status: "active" as Workspace["status"],
      evaluationEndsAt: null,
      plan: "solo" as PlanId | null,
      stripeSubscriptionId: "sub_1" as string | null,
      stripeCancelAt: null as Date | null,
      ...over,
    });
    const line = (
      status: "pending" | "scheduled",
      w = ws(),
      anotherFreeMonth = false,
      startsAt: Date | null = new Date("2026-10-28T16:00:00Z"),
    ) =>
      rewardStatusLine({
        reward: { status, startsAt },
        workspace: w,
        anotherFreeMonth,
        timeZone: TZ,
        now: NOW,
      });
    expect(line("pending")).toBe("You've earned a free month. We're setting it up now.");
    expect(line("pending", ws(), true)).toBe(
      "You've earned another free month. It starts at a renewal after this one ends.",
    );
    expect(
      line("pending", ws({ status: "evaluating", plan: null, stripeSubscriptionId: null })),
    ).toBe("You've earned a free month. It starts at your first renewal once you're on a plan.");
    expect(line("pending", ws({ status: "canceled", stripeSubscriptionId: null }))).toBe(
      "You've earned a free month. It waits for you if you start your plan again.",
    );
    expect(line("pending", ws({ status: "past_due" }))).toBe(
      "You've earned a free month. It starts once your payment goes through.",
    );
    expect(line("pending", ws({ status: "paused" }))).toBe(
      "You've earned a free month. It starts once your account is back on.",
    );
    const ending = ws({ stripeCancelAt: new Date("2026-10-28T16:00:00Z") });
    for (const s of ["pending", "scheduled"] as const)
      expect(line(s, ending)).toBe(
        "Your plan is set to end on Oct 28, so your free month waits. Turn renewal back on in Manage billing to use it.",
      );
    expect(line("scheduled")).toBe(
      "Thanks for the referral. Your next month is free, on Crew. It starts Oct 28, when your plan renews.",
    );
  });

  it("§4.3 the banner: back-to line, kept, Company → Company, the 3-day line, and when it hides", () => {
    const w = (over: Partial<Workspace> = {}) => ({
      status: "active" as Workspace["status"],
      evaluationEndsAt: null,
      setupPaidVia: "stripe" as Workspace["setupPaidVia"],
      plan: "solo" as PlanId | null,
      freePlan: "crew" as PlanId | null,
      freePlanUntil: NOV15 as Date | null,
      stripeCancelAt: null as Date | null,
      ...over,
    });
    const changes = endChanges({ to: "solo", countedInboxes: 3, autopilotCategoriesOn: 1 });
    const banner = (
      ws = w(),
      now = NOW,
      reward = { paidPlan: "solo" as PlanId, keptPriceCents: null as number | null },
    ) => freeMonthBanner({ workspace: ws, reward, changes, timeZone: TZ, now });
    expect(banner()).toEqual({
      line: "You're on Crew free until Nov 15 — then back to Solo.",
      link: { label: "Keep Crew?", href: "/billing#free-month" },
    });
    expect(banner(w(), new Date(NOV15.getTime() - 2 * DAY))?.line).toBe(
      "You're on Crew free until Nov 15 — then back to Solo: 2 inboxes pause and autopilot turns off.",
    );
    expect(banner(w(), new Date(NOV15.getTime() - 30 * 60_000))?.link).toBeNull();
    expect(
      banner(w({ plan: "crew" }), NOW, { paidPlan: "solo", keptPriceCents: 19_900 })?.line,
    ).toBe("You're on Crew free until Nov 15. Then Crew is $199 a month.");
    expect(
      banner(w({ plan: "company", freePlan: "company" }), NOW, {
        paidPlan: "company",
        keptPriceCents: null,
      })?.line,
    ).toBe("This month's free, thanks for the referral. Company renews Nov 15.");
    // setup_paid shows it too (a second card under "Setup's paid").
    expect(banner(w({ status: "setup_paid" }))).not.toBeNull();
    for (const hidden of [
      w({ status: "past_due" }),
      w({ status: "paused" }),
      w({ status: "canceled" }),
      w({ setupPaidVia: null }),
      w({ freePlanUntil: new Date(NOW.getTime() - 1) }),
      w({ freePlan: null }),
    ])
      expect(banner(hidden)).toBeNull();
  });

  it("§4.4 Plan & billing lines, Keep and Go back", () => {
    expect(billedPlanFreeLine("crew", NOV15, TZ)).toBe(
      "Crew is free until Nov 15, our thanks for the referral.",
    );
    expect(stripePageShowsLine("solo")).toBe("Stripe's page shows Solo, the plan you pay for.");
    expect(planChangesWaitLine(NOV15, TZ)).toBe(
      "Plan changes wait until your free month ends on Nov 15. Use Keep above, or update your card or cancel on Stripe's page.",
    );
    expect(
      freeMonthSummary({
        free: "crew",
        until: NOV15,
        backTo: "solo",
        backToPriceCents: 9_900,
        changes: endChanges({ to: "solo", countedInboxes: 3, autopilotCategoriesOn: 1 }),
        timeZone: TZ,
      }),
    ).toEqual([
      "You're on Crew free until Nov 15. Then you go back to Solo at $99 a month.",
      "Autopilot turns off then.",
      "2 of your 3 inboxes pause then; nothing is deleted.",
    ]);
    expect(
      freeMonthSummary({
        free: "company",
        until: NOV15,
        backTo: "crew",
        backToPriceCents: 19_900,
        changes: endChanges({ to: "crew", countedInboxes: 2, autopilotCategoriesOn: 1 }),
        timeZone: TZ,
      }),
    ).toEqual([
      "You're on Company free until Nov 15. Then you go back to Crew at $199 a month: up to 3 inboxes.",
    ]);
    expect(
      endChangeLines(endChanges({ to: "solo", countedInboxes: 2, autopilotCategoriesOn: 0 })),
    ).toEqual(["1 of your 2 inboxes pauses then; nothing is deleted."]);

    const keep = keepCopy({
      free: "crew",
      priceCents: 19_900,
      paidPriceCents: 9_900,
      firstChargeAt: NOV15,
      timeZone: TZ,
    });
    expect(keep).toEqual({
      button: "Keep Crew",
      title: "Keep Crew after Nov 15?",
      body: "Crew is $199 a month, plus sales tax where it applies. That's $100 more than you pay now. Your first Crew payment is on Nov 15. Nothing is charged today.",
      yes: "Yes, keep Crew at $199 a month",
      no: "Not now",
      notice: "Kept. Crew from Nov 15, at $199 a month.",
    });
    const back = goBackCopy({
      backTo: "solo",
      paidPriceCents: 9_900,
      at: NOV15,
      changes: endChanges({ to: "solo", countedInboxes: 1, autopilotCategoriesOn: 2 }),
      timeZone: TZ,
    });
    expect(back.button).toBe("Go back to Solo after Nov 15");
    expect(back.title).toBe("Go back to Solo after Nov 15?");
    expect(back.body).toEqual([
      "You'll pay $99 a month again, as before.",
      "Autopilot turns off then.",
    ]);
    expect(back.notice).toBe("Done. Back to Solo after Nov 15.");
  });

  it("§4.5 Settings and §4.6 Queue lines", () => {
    expect(planIncludes("solo")).toBe("Solo includes 1 inbox");
    expect(planIncludes("crew")).toBe("Crew includes 3 inboxes");
    expect(pausedInboxCopy("solo")).toEqual({
      line: "Paused. Solo includes 1 inbox. Nothing is read or drafted here, and nothing was deleted.",
      button: "Switch this one on instead",
      more: "or move to Crew in Plan & billing.",
    });
    expect(pausedInboxCopy("company").more).toBeNull();
    expect(reconnectRefusedLine("solo")).toBe(
      "This inbox is paused: Solo includes 1 inbox. Switch it on instead of another one, or move to Crew.",
    );
    expect(addInboxFreeMonthNote("crew", NOV15, TZ)).toBe(
      "This inbox pauses on Nov 15 unless you keep Crew. Nothing is deleted.",
    );
    expect(autopilotFreeMonthLine("crew", NOV15, TZ)).toBe(
      "Autopilot is part of your free Crew month until Nov 15.",
    );
    expect(pausedDraftsLine(3, "solo")).toBe(
      "3 replies are waiting in a paused inbox. Solo includes 1 inbox. They're still in that inbox's Gmail drafts.",
    );
    expect(pausedDraftsLine(1, "solo")).toBe(
      "1 reply is waiting in a paused inbox. Solo includes 1 inbox. It's still in that inbox's Gmail drafts.",
    );
    expect(inboxPausedSendLine("solo")).toBe(
      "This inbox is paused. Solo includes 1 inbox. The reply is still in that inbox's Gmail drafts.",
    );
  });
});
