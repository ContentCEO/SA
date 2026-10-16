import { isDeepStrictEqual } from "node:util";
import Stripe from "stripe";

/**
 * A fake Stripe account for unit tests (plan #47 offer A, design §5.2), modelled on the real
 * types of stripe@23 / API 2026-09-30: subscriptions with items and discounts
 * (`discount.source.coupon`), coupons, invoices (`parent.subscription_details`, `discounts`,
 * `total_discount_amounts`, `status`), invoice lines (`parent.subscription_item_details`,
 * `pricing.price_details.price`, `period`, `discount_amounts`), pending invoice items
 * (`proration`, `parent.subscription_details`), prices, customers, Checkout, the billing portal
 * and webhooks. `tests/unit/fake-stripe-types.test.ts` pins these shapes against the package's
 * own types.
 *
 * - Every call is recorded in `calls`; every write also in `writes`.
 * - Idempotency like Stripe v1: the same key with the same parameters replays the saved answer
 *   (including a saved error) without applying anything; the same key with different
 *   parameters throws StripeIdempotencyError. Errors injected with `failNext` stand for a
 *   dropped connection, so they are not saved under the key.
 * - `clock` is Stripe's clock (unix seconds), separate from the app's `now` (Test Clocks).
 * - `renew()` makes a renewal invoice; `portalChange()` a plan change on Stripe's own page.
 */

// --- Shapes (each a Pick of the real type, so a renamed field fails to compile) -------------

export type FakePrice = Pick<
  Stripe.Price,
  | "id"
  | "object"
  | "active"
  | "currency"
  | "lookup_key"
  | "product"
  | "tax_behavior"
  | "unit_amount"
>;
export type FakeSubscriptionItem = Pick<
  Stripe.SubscriptionItem,
  "id" | "object" | "current_period_start" | "current_period_end" | "quantity" | "subscription"
> & { price: FakePrice };
export type FakeSubscription = Pick<
  Stripe.Subscription,
  | "id"
  | "object"
  | "customer"
  | "status"
  | "metadata"
  | "cancel_at_period_end"
  | "cancel_at"
  | "schedule"
  | "billing_mode"
  | "test_clock"
> & {
  items: { object: "list"; data: FakeSubscriptionItem[]; has_more: boolean; url: string };
  discounts: Array<string | Stripe.Discount>;
};
export type FakeCoupon = Pick<
  Stripe.Coupon,
  "id" | "object" | "percent_off" | "amount_off" | "duration" | "name" | "metadata" | "valid"
>;
export type FakeLine = Pick<
  Stripe.InvoiceLineItem,
  | "id"
  | "object"
  | "amount"
  | "currency"
  | "description"
  | "discount_amounts"
  | "discounts"
  | "invoice"
  | "parent"
  | "period"
  | "pricing"
  | "quantity"
  | "subscription"
>;
export type FakeInvoice = Pick<
  Stripe.Invoice,
  | "id"
  | "object"
  | "billing_reason"
  | "created"
  | "customer"
  | "discounts"
  | "parent"
  | "status"
  | "subtotal"
  | "total"
  | "total_discount_amounts"
> & { lines: { object: "list"; data: FakeLine[]; has_more: boolean; url: string } };
export type FakeInvoiceItem = Pick<
  Stripe.InvoiceItem,
  | "id"
  | "object"
  | "amount"
  | "currency"
  | "customer"
  | "date"
  | "description"
  | "discountable"
  | "discounts"
  | "invoice"
  | "parent"
  | "period"
  | "proration"
>;
export type FakePortalConfiguration = Pick<
  Stripe.BillingPortal.Configuration,
  "id" | "object" | "active" | "is_default" | "updated" | "metadata"
> & {
  login_page: Pick<Stripe.BillingPortal.Configuration.LoginPage, "enabled" | "url">;
  features: {
    subscription_update: Pick<
      Stripe.BillingPortal.Configuration.Features.SubscriptionUpdate,
      "enabled" | "proration_behavior" | "default_allowed_updates" | "schedule_at_period_end"
    >;
  } & Record<string, unknown>;
};

export type Call = { method: string; args: unknown[] };

type Id = string | { id: string } | null | undefined;
const idOf = (v: Id) => (v == null ? null : typeof v === "string" ? v : v.id);
const clone = <T>(v: T): T => structuredClone(v);

/** The month after `seconds` (calendar month, UTC), as Stripe bills monthly plans. */
export function addMonth(seconds: number): number {
  const d = new Date(seconds * 1000);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return Math.floor(d.getTime() / 1000);
}

export const toSeconds = (d: Date) => Math.floor(d.getTime() / 1000);
export const fromSeconds = (s: number) => new Date(s * 1000);

/** A Stripe "No such …" refusal (404 resource_missing). */
export const missing = (what: string) =>
  new Stripe.errors.StripeInvalidRequestError({
    message: `No such ${what}`,
    code: "resource_missing",
    statusCode: 404,
    type: "invalid_request_error",
  });
const invalid = (message: string, code = "parameter_invalid") =>
  new Stripe.errors.StripeInvalidRequestError({
    message,
    code,
    statusCode: 400,
    type: "invalid_request_error",
  });

/** A thenable Stripe list that also auto-paginates with `for await`, like stripe-node's. */
function list<T>(items: T[]) {
  const page = { object: "list" as const, data: items, has_more: false, url: "" };
  return Object.assign(Promise.resolve(page), {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  });
}

type RequestOptions = { idempotencyKey?: string } & Record<string, unknown>;

export class FakeStripe {
  /** Every call, in order. Tests may empty it (`calls.length = 0`). */
  readonly calls: Call[] = [];
  /** Every write (anything that would change the Stripe account), in order. */
  readonly writes: Call[] = [];
  /** Stripe's clock in unix seconds. Starts at the test's NOW unless set. */
  clock: number;
  /** Stripe Tax's status, or an error `tax.settings.retrieve` throws. */
  tax: string | Error = "pending";
  /** An error a Checkout with these params throws (null = it goes through). */
  checkoutRefuses: (p: Stripe.Checkout.SessionCreateParams) => Error | null = () => null;

  readonly subscriptions = new Map<string, FakeSubscription>();
  readonly coupons = new Map<string, FakeCoupon>();
  readonly invoices = new Map<string, FakeInvoice>();
  readonly invoiceItems = new Map<string, FakeInvoiceItem>();
  readonly portalConfigurations = new Map<string, FakePortalConfiguration>();
  private readonly priceMap = new Map<string, FakePrice>();
  /** Every discount ever made, by id (a once-discount stays here after it's used up). */
  readonly discounts = new Map<string, Stripe.Discount>();

  private readonly idempotent = new Map<string, { params: unknown; ok?: unknown; err?: unknown }>();
  private readonly failures: { method: string; err: unknown }[] = [];
  private seq = 0;
  private readonly webhookSecret: string;

  constructor(opts: { now?: Date; webhookSecret?: string } = {}) {
    this.clock = toSeconds(opts.now ?? new Date());
    this.webhookSecret = opts.webhookSecret ?? "whsec_test";
  }

  private next(prefix: string) {
    return `${prefix}_${++this.seq}`;
  }

  // --- Test controls ------------------------------------------------------------------------

  /** The next call of `method` (e.g. "subscriptions.update") throws `err` instead. */
  failNext(method: string, err: unknown) {
    this.failures.push({ method, err });
  }

  setClock(d: Date) {
    this.clock = toSeconds(d);
  }

  advance(ms: number) {
    this.clock += Math.floor(ms / 1000);
  }

  /** The found-by-lookup-key prices (what `prices.list` returns). Setting replaces them all. */
  get prices(): FakePrice[] {
    return [...this.priceMap.values()];
  }
  set prices(found: Array<Partial<FakePrice> & { id: string }>) {
    this.priceMap.clear();
    for (const p of found) this.addPrice(p);
  }

  addPrice(p: Partial<FakePrice> & { id: string }): FakePrice {
    const price: FakePrice = {
      object: "price",
      active: true,
      currency: "usd",
      lookup_key: null,
      product: `prod_${p.id}`,
      tax_behavior: "exclusive",
      unit_amount: 0,
      ...p,
    };
    this.priceMap.set(price.id, price);
    return price;
  }

  price(id: string): FakePrice {
    const p = this.priceMap.get(id);
    if (!p) throw missing(`price: '${id}'`);
    return p;
  }

  /** How many default portal configurations the account already has. */
  set portals(n: number) {
    this.portalConfigurations.clear();
    for (let i = 0; i < n; i++) this.addPortalConfiguration({ id: `bpc_${i}` });
  }

  addPortalConfiguration(over: Partial<FakePortalConfiguration> = {}): FakePortalConfiguration {
    const c: FakePortalConfiguration = {
      id: over.id ?? this.next("bpc"),
      object: "billing_portal.configuration",
      active: true,
      is_default: this.portalConfigurations.size === 0,
      updated: this.clock,
      metadata: {},
      login_page: { enabled: false, url: null },
      features: {
        subscription_update: {
          enabled: true,
          proration_behavior: "create_prorations",
          default_allowed_updates: ["price"],
          schedule_at_period_end: { conditions: [] },
        },
      },
      ...over,
    };
    this.portalConfigurations.set(c.id, c);
    return c;
  }

  /** A live subscription on one plan price (the shape Checkout leaves behind). */
  addSubscription(o: {
    id?: string;
    customer: string;
    price: string;
    workspaceId?: string;
    status?: Stripe.Subscription.Status;
    mode?: "flexible" | "classic";
    periodStart?: Date;
    periodEnd?: Date;
  }): FakeSubscription {
    const id = o.id ?? this.next("sub");
    const start = o.periodStart ? toSeconds(o.periodStart) : this.clock;
    const sub: FakeSubscription = {
      id,
      object: "subscription",
      customer: o.customer,
      status: o.status ?? "active",
      metadata: o.workspaceId ? { workspaceId: o.workspaceId } : {},
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: null,
      billing_mode: { type: o.mode ?? "flexible", flexible: null },
      test_clock: null,
      discounts: [],
      items: {
        object: "list",
        has_more: false,
        url: `/v1/subscription_items?subscription=${id}`,
        data: [
          {
            id: this.next("si"),
            object: "subscription_item",
            price: clone(this.price(o.price)),
            quantity: 1,
            subscription: id,
            current_period_start: start,
            current_period_end: o.periodEnd ? toSeconds(o.periodEnd) : addMonth(start),
          },
        ],
      },
    };
    this.subscriptions.set(id, sub);
    return sub;
  }

  /** The stored subscription (not a copy): tests may change it directly. */
  sub(id: string): FakeSubscription {
    const s = this.subscriptions.get(id);
    if (!s) throw missing(`subscription: '${id}'`);
    return s;
  }

  /** Someone removed the discount in Stripe (Dashboard, a retention coupon, a schedule). */
  dropDiscount(subId: string, couponPrefix = "sa_ref_") {
    const sub = this.sub(subId);
    sub.discounts = sub.discounts.filter((d) => {
      const c = typeof d === "string" ? this.discounts.get(d)?.source.coupon : d.source.coupon;
      return !idOf(c as Id)?.startsWith(couponPrefix);
    });
  }

  addInvoiceItem(o: Partial<FakeInvoiceItem> & { customer: string; amount: number }) {
    const item: FakeInvoiceItem = {
      id: this.next("ii"),
      object: "invoiceitem",
      currency: "usd",
      date: this.clock,
      description: null,
      discountable: true,
      discounts: [],
      invoice: null,
      parent: null,
      period: { start: this.clock, end: this.clock },
      proration: false,
      ...o,
    };
    this.invoiceItems.set(item.id, item);
    return item;
  }

  /**
   * The subscription renews: a `subscription_cycle` invoice for the next period, made as a
   * draft (like Stripe, about an hour before it finalizes). The plan line takes the
   * subscription's discounts; pending prorations come in as their own lines, undiscounted.
   * The item's period moves on and Stripe's clock moves to the new period's start.
   * `finalize: true` finalizes it at once; "fails" leaves it a draft for good.
   */
  renew(subId: string, opts: { finalize?: boolean | "fails" } = {}): FakeInvoice {
    const sub = this.sub(subId);
    const item = sub.items.data[0]!;
    const start = item.current_period_end;
    const end = addMonth(start);
    this.clock = Math.max(this.clock, start);
    const invoiceId = this.next("in");
    const amount = (item.price.unit_amount ?? 0) * (item.quantity ?? 1);
    const discountAmounts: Stripe.InvoiceLineItem.DiscountAmount[] = [];
    let left = amount;
    for (const d of sub.discounts) {
      const discount = typeof d === "string" ? this.discounts.get(d)! : d;
      const coupon = this.coupons.get(idOf(discount.source.coupon as Id) ?? "");
      if (!coupon) continue;
      const off = Math.min(
        left,
        coupon.percent_off != null
          ? Math.round((amount * coupon.percent_off) / 100)
          : (coupon.amount_off ?? 0),
      );
      left -= off;
      discountAmounts.push({ amount: off, discount: discount.id });
    }
    const lines: FakeLine[] = [
      {
        id: this.next("il"),
        object: "line_item",
        amount,
        currency: "usd",
        description: `1 × ${item.price.id}`,
        discount_amounts: discountAmounts,
        discounts: discountAmounts.map((a) => idOf(a.discount as Id)!),
        invoice: invoiceId,
        parent: {
          type: "subscription_item_details",
          invoice_item_details: null,
          subscription_item_details: {
            subscription: subId,
            subscription_item: item.id,
            proration: false,
            proration_details: null,
            invoice_item: null,
          },
        },
        period: { start, end },
        pricing: {
          type: "price_details",
          price_details: { price: item.price.id, product: idOf(item.price.product as Id)! },
          unit_amount_decimal: null,
        },
        quantity: item.quantity ?? 1,
        subscription: subId,
      },
    ];
    for (const ii of this.invoiceItems.values()) {
      if (ii.invoice != null || ii.parent?.subscription_details?.subscription !== subId) continue;
      ii.invoice = invoiceId;
      lines.push({
        id: this.next("il"),
        object: "line_item",
        amount: ii.amount,
        currency: "usd",
        description: ii.description,
        discount_amounts: [],
        discounts: [],
        invoice: invoiceId,
        parent: {
          type: "invoice_item_details",
          subscription_item_details: null,
          invoice_item_details: {
            invoice_item: ii.id,
            proration: ii.proration,
            proration_details: null,
            subscription: subId,
          },
        },
        period: clone(ii.period),
        pricing: null,
        quantity: 1,
        subscription: subId,
      });
    }
    const subtotal = lines.reduce((s, l) => s + l.amount, 0);
    const discounted = discountAmounts.reduce((s, a) => s + a.amount, 0);
    const invoice: FakeInvoice = {
      id: invoiceId,
      object: "invoice",
      billing_reason: "subscription_cycle",
      created: this.clock,
      customer: sub.customer,
      discounts: discountAmounts.map((a) => idOf(a.discount as Id)!),
      parent: {
        type: "subscription_details",
        quote_details: null,
        subscription_details: { subscription: subId, metadata: clone(sub.metadata) },
      },
      status: "draft",
      subtotal,
      total: subtotal - discounted,
      total_discount_amounts: discountAmounts.map((a) => ({ ...a })),
      lines: {
        object: "list",
        data: lines,
        has_more: false,
        url: `/v1/invoices/${invoiceId}/lines`,
      },
    };
    this.invoices.set(invoiceId, invoice);
    item.current_period_start = start;
    item.current_period_end = end;
    if (opts.finalize === true) this.finalize(invoiceId);
    return invoice;
  }

  /**
   * The draft finalizes (and is paid). A once-discount it used now counts as used: Stripe
   * removes it from the subscription.
   */
  finalize(invoiceId: string): FakeInvoice {
    const inv = this.invoices.get(invoiceId);
    if (!inv) throw missing(`invoice: '${invoiceId}'`);
    inv.status = "paid";
    const subId = idOf(inv.parent?.subscription_details?.subscription as Id);
    if (subId && this.subscriptions.has(subId)) {
      const used = new Set(inv.discounts.map((d) => idOf(d as Id)));
      const sub = this.sub(subId);
      sub.discounts = sub.discounts.filter((d) => {
        const discount = typeof d === "string" ? this.discounts.get(d)! : d;
        const coupon = this.coupons.get(idOf(discount.source.coupon as Id) ?? "");
        return !(used.has(discount.id) && coupon?.duration === "once");
      });
    }
    return inv;
  }

  /**
   * The owner changes plan on Stripe's billing page mid-period (prorations created, billed on
   * the next invoice). The credit is what was really paid for the rest of the period ($0 after
   * a free plan line) — flexible mode credits the original debit, classic mode the current
   * price less the last discount, which come to the same here. The debit is the new price for
   * the rest of the period with the subscription's current discounts applied.
   */
  portalChange(
    subId: string,
    priceId: string,
  ): { credit: FakeInvoiceItem | null; debit: FakeInvoiceItem } {
    this.calls.push({ method: "portal.subscription_update", args: [subId, priceId] });
    this.writes.push({ method: "portal.subscription_update", args: [subId, priceId] });
    const sub = this.sub(subId);
    const item = sub.items.data[0]!;
    const start = item.current_period_start;
    const end = item.current_period_end;
    const now = Math.min(Math.max(this.clock, start), end);
    const fraction = (end - now) / (end - start);
    const last = [...this.invoices.values()]
      .reverse()
      .flatMap((i) => i.lines.data)
      .find(
        (l) =>
          l.parent?.subscription_item_details?.subscription === subId &&
          !l.parent.subscription_item_details.proration &&
          l.period.start === start,
      );
    const paid = last
      ? last.amount - (last.discount_amounts ?? []).reduce((s, a) => s + a.amount, 0)
      : (item.price.unit_amount ?? 0);
    const newPrice = this.price(priceId);
    let debitAmount = Math.round((newPrice.unit_amount ?? 0) * fraction);
    for (const d of sub.discounts) {
      const discount = typeof d === "string" ? this.discounts.get(d)! : d;
      const coupon = this.coupons.get(idOf(discount.source.coupon as Id) ?? "");
      if (coupon?.percent_off != null)
        debitAmount -= Math.round((debitAmount * coupon.percent_off) / 100);
    }
    const parent = {
      type: "subscription_details" as const,
      subscription_details: { subscription: subId, subscription_item: item.id },
    };
    const customer = idOf(sub.customer as Id)!;
    const creditAmount = -Math.round(paid * fraction);
    const credit =
      creditAmount !== 0
        ? this.addInvoiceItem({
            customer,
            amount: creditAmount,
            proration: true,
            parent,
            period: { start: now, end },
            description: `Unused time on ${item.price.id}`,
          })
        : null;
    const debit = this.addInvoiceItem({
      customer,
      amount: debitAmount,
      proration: true,
      parent,
      period: { start: now, end },
      description: `Remaining time on ${priceId}`,
    });
    item.price = clone(newPrice);
    return { credit, debit };
  }

  // --- The client the app talks to ------------------------------------------------------------

  /** What `setStripeForTests` takes. */
  get client(): Stripe {
    const call = <A extends unknown[], R>(method: string, fn: (...a: A) => R, write = false) =>
      (async (...args: A) => {
        this.calls.push({ method, args });
        const i = this.failures.findIndex((f) => f.method === method);
        if (i >= 0) throw this.failures.splice(i, 1)[0]!.err;
        const opts = args.find(
          (a): a is RequestOptions =>
            typeof a === "object" && a !== null && "idempotencyKey" in (a as object),
        );
        const key = opts?.idempotencyKey;
        if (key) {
          const params = args.filter((a) => a !== opts);
          const seen = this.idempotent.get(key);
          if (seen) {
            if (!isDeepStrictEqual(seen.params, params))
              throw new Stripe.errors.StripeIdempotencyError({
                message: "Keys for idempotent requests can only be used with the same parameters.",
                type: "idempotency_error",
                statusCode: 400,
              });
            if ("err" in seen) throw seen.err;
            return clone(seen.ok);
          }
          if (write) this.writes.push({ method, args });
          try {
            const ok = await fn(...args);
            this.idempotent.set(key, { params: clone(params), ok: clone(ok) });
            return ok;
          } catch (err) {
            this.idempotent.set(key, { params: clone(params), err });
            throw err;
          }
        }
        if (write) this.writes.push({ method, args });
        return fn(...args);
      }) as (...a: A) => Promise<Awaited<R>>;
    const listCall =
      <A extends unknown[], T>(method: string, fn: (...a: A) => T[]) =>
      (...args: A) => {
        this.calls.push({ method, args });
        const i = this.failures.findIndex((f) => f.method === method);
        if (i >= 0) {
          const err = this.failures.splice(i, 1)[0]!.err;
          // Rejects only when awaited or iterated (no unhandled rejection otherwise).
          return {
            then: (ok?: (v: never) => unknown, fail?: (e: unknown) => unknown) =>
              Promise.reject(err).then(ok, fail),
            async *[Symbol.asyncIterator]() {
              throw err;
            },
          };
        }
        return list(fn(...args));
      };

    const client = {
      tax: {
        settings: {
          retrieve: call("tax.settings.retrieve", () => {
            if (this.tax instanceof Error) throw this.tax;
            return { object: "tax.settings", status: this.tax };
          }),
        },
      },
      prices: {
        list: listCall("prices.list", (p?: Stripe.PriceListParams) =>
          this.prices.filter(
            (x) =>
              (!p?.lookup_keys || p.lookup_keys.includes(x.lookup_key ?? "")) &&
              (p?.active === undefined || x.active === p.active),
          ),
        ),
        create: call(
          "prices.create",
          (p: Stripe.PriceCreateParams) =>
            this.addPrice({
              id: `price_${p.lookup_key}`,
              lookup_key: p.lookup_key ?? null,
              unit_amount: p.unit_amount ?? 0,
              tax_behavior: p.tax_behavior ?? "unspecified",
            }),
          true,
        ),
        update: call(
          "prices.update",
          (id: string, p: Stripe.PriceUpdateParams) => {
            const price = this.priceMap.get(id);
            if (price && p.tax_behavior) price.tax_behavior = p.tax_behavior;
            return { id };
          },
          true,
        ),
        retrieve: call("prices.retrieve", (id: string) =>
          clone(this.priceMap.get(id) ?? { id, product: `prod_${id}` }),
        ),
      },
      customers: {
        create: call("customers.create", () => ({ id: `cus_${++this.customerSeq}` }), true),
      },
      checkout: {
        sessions: {
          create: call(
            "checkout.sessions.create",
            (p: Stripe.Checkout.SessionCreateParams) => {
              const refused = this.checkoutRefuses(p);
              if (refused) throw refused;
              return { id: `cs_${++this.checkoutSeq}`, url: "https://checkout.example/cs" };
            },
            true,
          ),
        },
      },
      billingPortal: {
        configurations: {
          list: listCall("billingPortal.configurations.list", (p?: { is_default?: boolean }) =>
            [...this.portalConfigurations.values()]
              .filter((c) => p?.is_default === undefined || c.is_default === p.is_default)
              .map(clone),
          ),
          retrieve: call("billingPortal.configurations.retrieve", (id: string) => {
            const c = this.portalConfigurations.get(id);
            if (!c) throw missing(`configuration: '${id}'`);
            return clone(c);
          }),
          create: call(
            "billingPortal.configurations.create",
            (p: Stripe.BillingPortal.ConfigurationCreateParams) =>
              clone(
                this.addPortalConfiguration({
                  id: "bpc_new",
                  is_default: false,
                  metadata: (p.metadata as Record<string, string>) ?? {},
                  features: { ...(p.features as Record<string, unknown>) } as never,
                }),
              ),
            true,
          ),
          update: call(
            "billingPortal.configurations.update",
            (id: string, p: Stripe.BillingPortal.ConfigurationUpdateParams) => {
              const c = this.portalConfigurations.get(id);
              if (!c) throw missing(`configuration: '${id}'`);
              if (p.active !== undefined) c.active = p.active;
              if (p.features) Object.assign(c.features, p.features);
              c.updated = this.clock;
              return clone(c);
            },
            true,
          ),
        },
        sessions: {
          create: call(
            "billingPortal.sessions.create",
            (p: Stripe.BillingPortal.SessionCreateParams) => ({
              id: this.next("bps"),
              url: `https://billing.example/${p.customer}`,
              configuration: p.configuration ?? null,
            }),
            true,
          ),
        },
      },
      webhookEndpoints: {
        list: listCall("webhookEndpoints.list", () => []),
        del: call("webhookEndpoints.del", () => ({}), true),
        create: call("webhookEndpoints.create", () => ({ id: "we_1", secret: "whsec_new" }), true),
      },
      webhooks: {
        constructEventAsync: async (body: string, sig: string, secret: string) => {
          if (sig !== "good" || secret !== this.webhookSecret)
            throw new Error("No signatures found");
          return JSON.parse(body);
        },
      },
      coupons: {
        create: call(
          "coupons.create",
          (p: Stripe.CouponCreateParams) => {
            const id = p.id ?? this.next("coupon");
            if (this.coupons.has(id))
              throw invalid(`Coupon already exists.`, "resource_already_exists");
            const coupon: FakeCoupon = {
              id,
              object: "coupon",
              percent_off: p.percent_off ?? null,
              amount_off: p.amount_off ?? null,
              duration: p.duration ?? "once",
              name: p.name ?? null,
              metadata: (p.metadata as Record<string, string>) ?? {},
              valid: true,
            };
            this.coupons.set(id, coupon);
            return clone(coupon);
          },
          true,
        ),
      },
      subscriptions: {
        retrieve: call("subscriptions.retrieve", (id: string, p?: { expand?: string[] }) =>
          this.view(this.sub(id), p?.expand),
        ),
        update: call(
          "subscriptions.update",
          (id: string, p: Stripe.SubscriptionUpdateParams) => this.updateSub(id, p),
          true,
        ),
        cancel: call(
          "subscriptions.cancel",
          (id: string) => {
            const sub = this.sub(id);
            sub.status = "canceled";
            return this.view(sub);
          },
          true,
        ),
      },
      invoices: {
        list: listCall("invoices.list", (p?: Stripe.InvoiceListParams) =>
          [...this.invoices.values()]
            .filter(
              (i) =>
                (!p?.subscription ||
                  idOf(i.parent?.subscription_details?.subscription as Id) === p.subscription) &&
                (!p?.customer || i.customer === p.customer),
            )
            .reverse()
            .slice(0, p?.limit ?? 10)
            .map(clone),
        ),
        retrieve: call("invoices.retrieve", (id: string) => {
          const inv = this.invoices.get(id);
          if (!inv) throw missing(`invoice: '${id}'`);
          return clone(inv);
        }),
        listLineItems: listCall("invoices.listLineItems", (id: string) => {
          const inv = this.invoices.get(id);
          if (!inv) throw missing(`invoice: '${id}'`);
          return clone(inv.lines.data);
        }),
      },
      invoiceItems: {
        list: listCall("invoiceItems.list", (p?: Stripe.InvoiceItemListParams) =>
          [...this.invoiceItems.values()]
            .filter(
              (i) =>
                (!p?.customer || i.customer === p.customer) &&
                (p?.pending === undefined || (i.invoice == null) === p.pending),
            )
            .map(clone),
        ),
        del: call(
          "invoiceItems.del",
          (id: string) => {
            const item = this.invoiceItems.get(id);
            if (!item) throw missing(`invoiceitem: '${id}'`);
            if (item.invoice != null) throw invalid("This invoice item is already on an invoice.");
            this.invoiceItems.delete(id);
            return { id, object: "invoiceitem", deleted: true };
          },
          true,
        ),
      },
    };
    return client as unknown as Stripe;
  }

  private customerSeq = 0;
  private checkoutSeq = 0;

  /** What a read returns: a copy, with discounts as ids unless expanded. */
  private view(sub: FakeSubscription, expand: string[] = []): FakeSubscription {
    const out = clone(sub);
    out.discounts = sub.discounts.map((d) => {
      const discount = typeof d === "string" ? this.discounts.get(d)! : d;
      return expand.includes("discounts") ? clone(discount) : discount.id;
    });
    return out;
  }

  private updateSub(id: string, p: Stripe.SubscriptionUpdateParams): FakeSubscription {
    const sub = this.sub(id);
    if (sub.status === "canceled") throw invalid("A canceled subscription can't be updated.");
    if (p.discounts !== undefined) {
      const wanted = p.discounts === "" || p.discounts == null ? [] : p.discounts;
      if (wanted.length > 20) throw invalid("A subscription can have at most 20 discounts.");
      const current = new Map(
        sub.discounts.map((d) => {
          const discount = typeof d === "string" ? this.discounts.get(d)! : d;
          return [discount.id, discount] as const;
        }),
      );
      const next: Stripe.Discount[] = [];
      for (const w of wanted) {
        if (w.discount) {
          const kept = current.get(w.discount);
          if (!kept) throw invalid(`No such discount on this subscription: '${w.discount}'`);
          next.push(kept);
        } else if (w.coupon) {
          if (!this.coupons.has(w.coupon)) throw missing(`coupon: '${w.coupon}'`);
          const discount: Stripe.Discount = {
            id: this.next("di"),
            object: "discount",
            checkout_session: null,
            customer: sub.customer as string,
            customer_account: null,
            end: null,
            invoice: null,
            invoice_item: null,
            promotion_code: null,
            source: { coupon: w.coupon, type: "coupon" },
            start: this.clock,
            subscription: id,
            subscription_item: null,
          };
          this.discounts.set(discount.id, discount);
          next.push(discount);
        } else {
          throw invalid("Each discount needs a coupon or a discount.");
        }
      }
      sub.discounts = next;
    }
    if (p.items) {
      for (const it of p.items) {
        const item = sub.items.data.find((x) => x.id === it.id);
        if (!item) throw invalid(`No such subscription item: '${it.id}'`);
        if (it.price) item.price = clone(this.price(it.price));
      }
    }
    if (p.cancel_at_period_end !== undefined) sub.cancel_at_period_end = p.cancel_at_period_end;
    if (p.metadata && typeof p.metadata === "object")
      sub.metadata = { ...sub.metadata, ...(p.metadata as Record<string, string>) };
    return this.view(sub);
  }
}

/** The usual `Stripe.errors` classes, for tests that throw them through `failNext`. */
export const stripeErrors = {
  connection: () =>
    new Stripe.errors.StripeConnectionError({ message: "connection reset", type: "api_error" }),
  api: () =>
    new Stripe.errors.StripeAPIError({ message: "boom", type: "api_error", statusCode: 500 }),
  rateLimit: () =>
    new Stripe.errors.StripeRateLimitError({
      message: "slow down",
      code: "rate_limit",
      type: "invalid_request_error",
      statusCode: 429,
    }),
  missing,
  invalid,
};
