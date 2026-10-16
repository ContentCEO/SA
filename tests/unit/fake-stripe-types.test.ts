import type Stripe from "stripe";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  chargesForFreeDays,
  couponOf,
  invoiceSubscriptionId,
  invoiceUsed,
  linePriceId,
  planLine,
  planLineFullyFree,
} from "@/server/referral-rules";
import {
  FakeStripe,
  fromSeconds,
  stripeErrors,
  type FakeCoupon,
  type FakeInvoice,
  type FakeInvoiceItem,
  type FakeLine,
  type FakePortalConfiguration,
  type FakeSubscription,
  type FakeSubscriptionItem,
} from "../support/fake-stripe";

/**
 * The fake Stripe (tests/support/fake-stripe.ts) is only worth trusting if its objects have the
 * real API's shapes (stripe@23, API 2026-09-30) and behave like Stripe where the referral code
 * depends on it. Every Fake* type is a Pick of the package's own type, so a renamed field fails
 * to compile; the checks below pin the nested shapes the code reads.
 */
describe("fake Stripe shapes match the stripe package's types", () => {
  it("subscriptions, items, discounts and coupons", () => {
    expectTypeOf<FakeSubscription["discounts"]>().toEqualTypeOf<Stripe.Subscription["discounts"]>();
    expectTypeOf<FakeSubscription["billing_mode"]>().toEqualTypeOf<
      Stripe.Subscription["billing_mode"]
    >();
    expectTypeOf<FakeSubscription["schedule"]>().toEqualTypeOf<Stripe.Subscription["schedule"]>();
    expectTypeOf<FakeSubscriptionItem["current_period_end"]>().toEqualTypeOf<
      Stripe.SubscriptionItem["current_period_end"]
    >();
    // The coupon lives on `discount.source.coupon` (no top-level `coupon` any more).
    expectTypeOf<Stripe.Discount["source"]["coupon"]>().toEqualTypeOf<
      string | Stripe.Coupon | null
    >();
    expectTypeOf<FakeCoupon["duration"]>().toEqualTypeOf<Stripe.Coupon["duration"]>();
  });

  it("invoices, lines and pending invoice items", () => {
    expectTypeOf<FakeInvoice["parent"]>().toEqualTypeOf<Stripe.Invoice["parent"]>();
    expectTypeOf<FakeInvoice["discounts"]>().toEqualTypeOf<Stripe.Invoice["discounts"]>();
    expectTypeOf<FakeInvoice["total_discount_amounts"]>().toEqualTypeOf<
      Stripe.Invoice["total_discount_amounts"]
    >();
    expectTypeOf<FakeInvoice["billing_reason"]>().toEqualTypeOf<Stripe.Invoice["billing_reason"]>();
    expectTypeOf<FakeLine["parent"]>().toEqualTypeOf<Stripe.InvoiceLineItem["parent"]>();
    expectTypeOf<FakeLine["pricing"]>().toEqualTypeOf<Stripe.InvoiceLineItem["pricing"]>();
    expectTypeOf<FakeLine["discount_amounts"]>().toEqualTypeOf<
      Stripe.InvoiceLineItem["discount_amounts"]
    >();
    expectTypeOf<FakeInvoiceItem["parent"]>().toEqualTypeOf<Stripe.InvoiceItem["parent"]>();
    expectTypeOf<FakeInvoiceItem["proration"]>().toEqualTypeOf<boolean>();
  });

  it("the billing portal configuration", () => {
    expectTypeOf<
      FakePortalConfiguration["features"]["subscription_update"]["schedule_at_period_end"]
    >().toEqualTypeOf<
      Stripe.BillingPortal.Configuration.Features.SubscriptionUpdate["schedule_at_period_end"]
    >();
    expectTypeOf<FakePortalConfiguration["updated"]>().toEqualTypeOf<number>();
  });
});

const NOW = new Date("2026-10-16T15:00:00Z");

function account() {
  const fake = new FakeStripe({ now: NOW });
  fake.addPrice({ id: "price_solo", lookup_key: "sa_solo_9900_month", unit_amount: 9_900 });
  fake.addPrice({ id: "price_crew", lookup_key: "sa_crew_19900_month", unit_amount: 19_900 });
  const sub = fake.addSubscription({ id: "sub_1", customer: "cus_1", price: "price_solo" });
  return { fake, s: fake.client, sub };
}

const coupon = { id: "sa_ref_r1", percent_off: 100, duration: "once" as const };

describe("fake Stripe behaves like Stripe where the referral code depends on it", () => {
  it("idempotency: same key + same params replays without applying; different params refuse", async () => {
    const { fake, s } = account();
    await s.coupons.create(coupon);
    const key = { idempotencyKey: "referral-attach-r1-a0" };
    const first = await s.subscriptions.update(
      "sub_1",
      { discounts: [{ coupon: coupon.id }] },
      key,
    );
    // Something else changes the subscription; the replay must not put the discount back.
    fake.dropDiscount("sub_1");
    const replay = await s.subscriptions.update(
      "sub_1",
      { discounts: [{ coupon: coupon.id }] },
      key,
    );
    expect(replay).toEqual(first);
    expect(fake.sub("sub_1").discounts).toEqual([]);
    expect(fake.writes.filter((w) => w.method === "subscriptions.update")).toHaveLength(1);
    await expect(s.subscriptions.update("sub_1", { discounts: "" }, key)).rejects.toMatchObject({
      type: "StripeIdempotencyError",
    });
  });

  it("a saved error replays too; a failNext error isn't saved", async () => {
    const { fake, s } = account();
    const key = { idempotencyKey: "k1" };
    await expect(
      s.subscriptions.update("sub_1", { discounts: [{ coupon: "nope" }] }, key),
    ).rejects.toMatchObject({ code: "resource_missing" });
    await s.coupons.create({ ...coupon, id: "nope" });
    await expect(
      s.subscriptions.update("sub_1", { discounts: [{ coupon: "nope" }] }, key),
    ).rejects.toMatchObject({ code: "resource_missing" });

    fake.failNext("subscriptions.update", stripeErrors.connection());
    const k2 = { idempotencyKey: "k2" };
    await expect(
      s.subscriptions.update("sub_1", { discounts: [{ coupon: "nope" }] }, k2),
    ).rejects.toMatchObject({ type: "StripeConnectionError" });
    const ok = await s.subscriptions.update("sub_1", { discounts: [{ coupon: "nope" }] }, k2);
    expect(ok.discounts).toHaveLength(1);
  });

  it("coupons: a second create with the same id says resource_already_exists", async () => {
    const { s } = account();
    await s.coupons.create(coupon);
    await expect(s.coupons.create(coupon)).rejects.toMatchObject({
      type: "StripeInvalidRequestError",
      code: "resource_already_exists",
      statusCode: 400,
    });
  });

  it("reads give discount ids unless expanded; expanded ones carry source.coupon", async () => {
    const { s } = account();
    await s.coupons.create(coupon);
    await s.subscriptions.update("sub_1", { discounts: [{ coupon: coupon.id }] });
    const plain = await s.subscriptions.retrieve("sub_1");
    expect(typeof plain.discounts[0]).toBe("string");
    const full = await s.subscriptions.retrieve("sub_1", { expand: ["discounts"] });
    expect(couponOf(full.discounts[0]!)).toBe(coupon.id);
    expect((full.discounts[0] as Stripe.Discount).start).toBe(Math.floor(NOW.getTime() / 1000));
    await expect(s.subscriptions.retrieve("sub_nope")).rejects.toMatchObject({
      code: "resource_missing",
    });
  });

  it("renew: a draft whose plan line takes the once-discount; prorations come in undiscounted", async () => {
    const { fake, s } = account();
    await s.coupons.create(coupon);
    const after = await s.subscriptions.update("sub_1", { discounts: [{ coupon: coupon.id }] });
    const discountId = after.discounts[0] as string;
    fake.addInvoiceItem({
      customer: "cus_1",
      amount: 4_000,
      proration: true,
      parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } },
    });

    const inv = fake.renew("sub_1");
    expect(inv.status).toBe("draft");
    expect(inv.billing_reason).toBe("subscription_cycle");
    expect(invoiceSubscriptionId(inv as unknown as Stripe.Invoice)).toBe("sub_1");
    expect(invoiceUsed(inv as unknown as Stripe.Invoice, discountId)).toBe(true);
    const lines = inv.lines.data as unknown as Stripe.InvoiceLineItem[];
    const plan = planLine(lines, "sub_1")!;
    expect(linePriceId(plan)).toBe("price_solo");
    expect(planLineFullyFree(plan, discountId)).toBe(true);
    expect(inv.total).toBe(4_000); // the plan's month is free; the proration isn't
    expect(fromSeconds(plan.period.start)).toEqual(new Date("2026-11-16T15:00:00Z"));
    // Used, but still on the subscription until the invoice finalizes.
    expect(fake.sub("sub_1").discounts).toHaveLength(1);
    fake.finalize(inv.id);
    expect(fake.sub("sub_1").discounts).toHaveLength(0);
    // The next renewal is full price.
    expect(fake.renew("sub_1", { finalize: true }).total).toBe(9_900);
  });

  it("portalChange after a free plan line: the credit is $0, the debit is real", async () => {
    const { fake, s } = account();
    await s.coupons.create(coupon);
    await s.subscriptions.update("sub_1", { discounts: [{ coupon: coupon.id }] });
    fake.renew("sub_1", { finalize: true });
    fake.advance(10 * 86_400_000);
    const { credit, debit } = fake.portalChange("sub_1", "price_crew");
    expect(credit).toBeNull();
    expect(debit.amount).toBeGreaterThan(0);
    expect(debit.amount).toBeLessThan(19_900);
    const pending: Stripe.InvoiceItem[] = [];
    for await (const item of s.invoiceItems.list({ customer: "cus_1", pending: true, limit: 100 }))
      pending.push(item);
    const plan = fake.sub("sub_1").items.data[0]!;
    expect(
      chargesForFreeDays(
        pending,
        "sub_1",
        fromSeconds(plan.current_period_start),
        fromSeconds(plan.current_period_end),
      ),
    ).toEqual([debit.id]);
    await s.invoiceItems.del(debit.id);
    await expect(s.invoiceItems.del(debit.id)).rejects.toMatchObject({ code: "resource_missing" });
  });

  it("invoices list newest first, and a failNext error reaches `for await` too", async () => {
    const { fake, s } = account();
    const a = fake.renew("sub_1", { finalize: true });
    const b = fake.renew("sub_1");
    expect(
      (await s.invoices.list({ subscription: "sub_1", limit: 10 })).data.map((i) => i.id),
    ).toEqual([b.id, a.id]);
    fake.failNext("invoiceItems.list", stripeErrors.api());
    await expect(async () => {
      for await (const _ of s.invoiceItems.list({ customer: "cus_1", pending: true })) void _;
    }).rejects.toMatchObject({ type: "StripeAPIError" });
  });

  it("Go back to the exact price; discounts can be cleared with an empty string", async () => {
    const { fake, s } = account();
    const item = fake.sub("sub_1").items.data[0]!;
    await s.subscriptions.update("sub_1", {
      items: [{ id: item.id, price: "price_crew" }],
      proration_behavior: "none",
    });
    expect(fake.sub("sub_1").items.data[0]!.price.id).toBe("price_crew");
    await s.coupons.create(coupon);
    await s.subscriptions.update("sub_1", { discounts: [{ coupon: coupon.id }] });
    await s.subscriptions.update("sub_1", { discounts: "" });
    expect(fake.sub("sub_1").discounts).toEqual([]);
    // No proration was made for the plan change.
    expect([...fake.invoiceItems.values()]).toHaveLength(0);
  });

  it("the portal: default configurations, retrieve/update with `updated`", async () => {
    const { fake, s } = account();
    const c = fake.addPortalConfiguration();
    expect((await s.billingPortal.configurations.list({ is_default: true })).data).toHaveLength(1);
    const before = c.updated;
    fake.advance(60_000);
    const updated = await s.billingPortal.configurations.update(c.id, { active: false });
    expect(updated.active).toBe(false);
    expect(updated.updated).toBeGreaterThan(before);
    await expect(s.billingPortal.configurations.retrieve("bpc_nope")).rejects.toMatchObject({
      code: "resource_missing",
    });
  });
});
