import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pricing } from "@/config/pricing";
import type { Database } from "@/db";
import {
  activityLog,
  appSettings,
  drafts,
  mailboxes,
  rules,
  stripeEvents,
  threads,
  workspaces,
  type Workspace,
} from "@/db/schema";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { encryptSecret } from "@/lib/crypto";
import { ensureUserAndWorkspace } from "@/server/accounts";
import {
  applyCheckoutCompleted,
  applySubscription,
  CheckoutNotAllowedError,
  connectStripe,
  createCheckout,
  createPortal,
  handleStripeWebhook,
  NO_PLAN_CHANGE_PORTAL_KEY,
  noPlanChangePortalParams,
  portalStatus,
  salesTaxStatus,
  setStripeForTests,
  termsBoxOffSince,
} from "@/server/billing";
import {
  billingStatusLine,
  checkoutTerms,
  planFromLookupKey,
  planLookupKey,
  SALES_TAX_LINES,
  SALES_TAX_NOTE,
  SALES_TAX_ON_NOTE,
  SETUP_NOT_PAID_LINE,
  setupLookupKey,
  statusAfterCheckout,
  statusAfterSubscription,
  TERMS_BOX_OFF_LINE,
  downgradePausesLine,
} from "@/server/billing-rules";
import { canSend, jobsAllowed } from "@/server/lifecycle";
import { isTermsUrlMissingError } from "@/server/stripe-error-rules";
import { createTestDb } from "../support/db";
import { FakeStripe, stripeErrors, type Call } from "../support/fake-stripe";

const NOW = new Date("2026-10-10T14:00:00Z");
type S = Workspace["status"];
const w = (status: S, over: Partial<Workspace> = {}) => ({
  status,
  evaluationEndsAt: null,
  setupPaidAt: null,
  setupPaidVia: null,
  setupCallCompletedAt: null,
  stripeSubscriptionId: null,
  ...over,
});

describe("billing rules", () => {
  it("lookup keys carry the amount and map back to the plan", () => {
    expect(setupLookupKey()).toBe(`sa_setup_${pricing.setupFee.amountCents}`);
    for (const plan of ["solo", "crew", "company"] as const) {
      expect(planFromLookupKey(planLookupKey(plan))).toBe(plan);
    }
    expect(planFromLookupKey("sa_setup_49900")).toBeNull();
    expect(planFromLookupKey("someone_elses_price")).toBeNull();
    expect(planFromLookupKey(null)).toBeNull();
  });

  it("charges the setup fee once, and only without a live subscription", () => {
    expect(checkoutTerms(w("evaluating"), NOW)).toEqual({ allowed: true, includeSetupFee: true });
    expect(checkoutTerms(w("canceled", { setupPaidAt: NOW, setupPaidVia: "stripe" }), NOW)).toEqual(
      {
        allowed: true,
        includeSetupFee: false,
      },
    );
    // Marked paid by hand (before 2026-10-10), never paid through Stripe: the fee is still owed.
    expect(checkoutTerms(w("setup_paid", { setupPaidAt: NOW }), NOW).includeSetupFee).toBe(true);
    expect(checkoutTerms(w("active", { stripeSubscriptionId: "sub_1" }), NOW).allowed).toBe(false);
    expect(checkoutTerms(w("paused"), NOW).allowed).toBe(false);
  });

  it("/billing never tells an account that hasn't really paid that setup's paid or it renews", () => {
    // Hand-marked before 2026-10-10, or reset after a test card: status kept, no real payment.
    for (const s of ["setup_paid", "active"] as S[]) {
      expect(billingStatusLine(w(s, { setupPaidAt: NOW }), NOW)).toBe(SETUP_NOT_PAID_LINE);
      expect(SETUP_NOT_PAID_LINE).toBe("Sending turns on once your setup payment goes through.");
    }
    expect(billingStatusLine(w("setup_paid", { setupPaidVia: "stripe" }), NOW)).toMatch(
      /^Setup's paid and sending is on/,
    );
    expect(billingStatusLine(w("active", { setupPaidVia: "house" }), NOW)).toBe(
      "All set. Your plan renews monthly.",
    );
    expect(billingStatusLine(w("past_due"), NOW)).toMatch(/payment didn't go through/);
    expect(billingStatusLine(w("evaluating"), NOW)).toBeNull();
    // The page uses the rule, and only mentions Stripe's page next to Manage billing.
    const page = readFileSync("src/app/(app)/billing/page.tsx", "utf8");
    expect(page).toContain("const statusLine = billingStatusLine(workspace);");
    const portal = page.slice(page.indexOf("{workspace.stripeCustomerId ? ("));
    expect(portal.indexOf("Stripe&apos;s secure")).toBeGreaterThan(-1);
    expect(portal.indexOf("Stripe&apos;s secure")).toBeLessThan(portal.indexOf(") : null}"));
  });

  it("paying turns sending on, and keeps a finished setup active", () => {
    for (const s of ["invited", "evaluating", "evaluation_expired", "canceled"] as S[]) {
      expect(statusAfterCheckout(w(s), NOW)).toBe("setup_paid");
    }
    expect(statusAfterCheckout(w("canceled", { setupCallCompletedAt: NOW }), NOW)).toBe("active");
    expect(statusAfterCheckout(w("active"), NOW)).toBe("active");
    // The status alone never turns sending on — the webhook also records the Stripe payment.
    expect(canSend(w(statusAfterCheckout(w("evaluating"), NOW)), NOW)).toBe(false);
    expect(
      canSend(w(statusAfterCheckout(w("evaluating"), NOW), { setupPaidVia: "stripe" }), NOW),
    ).toBe(true);
  });

  it("failed payments pause, recovered payments restore, ended plans go read-only", () => {
    expect(statusAfterSubscription(w("active"), "past_due", NOW)).toBe("past_due");
    expect(statusAfterSubscription(w("setup_paid"), "unpaid", NOW)).toBe("past_due");
    expect(jobsAllowed(w("past_due"), NOW)).toBe(false);
    expect(statusAfterSubscription(w("past_due"), "active", NOW)).toBe("setup_paid");
    expect(
      statusAfterSubscription(w("past_due", { setupCallCompletedAt: NOW }), "active", NOW),
    ).toBe("active");
    expect(statusAfterSubscription(w("active"), "canceled", NOW)).toBe("canceled");
    expect(statusAfterSubscription(w("past_due"), "incomplete_expired", NOW)).toBe("canceled");
    expect(jobsAllowed(w("canceled"), NOW)).toBe(false);
  });

  it("never touches accounts Stripe doesn't own (paused, trial) or unknown states", () => {
    expect(statusAfterSubscription(w("paused"), "past_due", NOW)).toBe("paused");
    expect(statusAfterSubscription(w("paused"), "canceled", NOW)).toBe("paused");
    expect(statusAfterSubscription(w("evaluating"), "canceled", NOW)).toBe("evaluating");
    expect(statusAfterSubscription(w("active"), "incomplete", NOW)).toBe("active");
    expect(statusAfterSubscription(w("active"), "trialing", NOW)).toBe("active");
  });
});

// --- With a database and a fake Stripe -------------------------------------

const SECRET = "whsec_test";

/** The shared fake Stripe account (tests/support/fake-stripe.ts). */
let fake: FakeStripe;

let database: Database;
let calls: Call[];
let workspace: Workspace;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.APP_URL = "https://app.example";
  delete process.env.STRIPE_WEBHOOK_SECRET;
  database = await createTestDb();
  fake = new FakeStripe({ now: NOW, webhookSecret: SECRET });
  calls = fake.calls;
  setStripeForTests(fake.client);
  ({ workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com", name: "Owner" }));
  await database
    .update(workspaces)
    .set({ status: "evaluating", evaluationEndsAt: new Date(Date.now() + 86_400_000) })
    .where(eq(workspaces.id, workspace.id));
  await database
    .insert(appSettings)
    .values({ key: "stripe_webhook_secret", value: encryptSecret(SECRET) });
});
afterEach(() => {
  setStripeForTests(undefined);
  vi.restoreAllMocks();
});

async function reload() {
  const [row] = await database.select().from(workspaces).where(eq(workspaces.id, workspace.id));
  return row;
}

const paidSession = (over: Partial<Stripe.Checkout.Session> = {}) =>
  ({
    id: "cs_1",
    mode: "subscription",
    payment_status: "paid",
    customer: "cus_1",
    subscription: "sub_1",
    client_reference_id: workspace.id,
    metadata: { workspaceId: workspace.id, plan: "crew", includesSetup: "1" },
    ...over,
  }) as unknown as Stripe.Checkout.Session;

const subscription = (status: string, plan: "solo" | "crew" | "company" = "crew") =>
  ({
    id: "sub_1",
    status,
    metadata: { workspaceId: workspace.id },
    items: { data: [{ price: { lookup_key: planLookupKey(plan) } }] },
  }) as unknown as Stripe.Subscription;

describe("checkout", () => {
  it("includes the setup fee on the first payment and tags the workspace", async () => {
    const url = await createCheckout(await reload(), "crew");
    expect(url).toBe("https://checkout.example/cs");
    const create = calls.find((c) => c.method === "checkout.sessions.create")!;
    const params = create.args[0] as Stripe.Checkout.SessionCreateParams;
    expect(params.line_items).toHaveLength(2);
    expect(params.metadata).toMatchObject({ workspaceId: workspace.id, plan: "crew" });
    expect(params.success_url).toBe("https://app.example/billing?done=paid");
    expect((await reload()).stripeCustomerId).toBe("cus_1");
  });

  it("leaves the setup fee off once it's paid, and reuses the customer", async () => {
    await database
      .update(workspaces)
      .set({
        status: "canceled",
        setupPaidAt: NOW,
        setupPaidVia: "stripe",
        stripeCustomerId: "cus_old",
      })
      .where(eq(workspaces.id, workspace.id));
    await createCheckout(await reload(), "solo");
    const params = calls.find((c) => c.method === "checkout.sessions.create")!
      .args[0] as Stripe.Checkout.SessionCreateParams;
    expect(params.line_items).toHaveLength(1);
    expect(params.customer).toBe("cus_old");
    expect(calls.some((c) => c.method === "customers.create")).toBe(false);
  });

  it("refuses a second subscription", async () => {
    await database
      .update(workspaces)
      .set({ status: "active", stripeSubscriptionId: "sub_1" })
      .where(eq(workspaces.id, workspace.id));
    await expect(createCheckout(await reload(), "crew")).rejects.toBeInstanceOf(
      CheckoutNotAllowedError,
    );
    expect(calls.some((c) => c.method === "checkout.sessions.create")).toBe(false);
  });
});

describe("the 'I agree' box at checkout (Davi, 2026-10-15)", () => {
  const creates = () =>
    calls
      .filter((c) => c.method === "checkout.sessions.create")
      .map((c) => c.args[0] as Stripe.Checkout.SessionCreateParams);
  /** What Stripe answers while no terms link is saved in its dashboard (an invalid request). */
  const noTermsUrl = () =>
    new Stripe.errors.StripeInvalidRequestError({
      message:
        "You cannot collect consent to your terms of service unless a URL is set in the Stripe Dashboard. Update your public business details at https://dashboard.stripe.com/settings/public to set your terms of service URL.",
      param: "consent_collection[terms_of_service]",
    });
  const boxOffRow = async () =>
    (
      await database.select().from(appSettings).where(eq(appSettings.key, "stripe_terms_box_off"))
    )[0];

  it("asks for the box, next to our own words linking our terms and privacy policy", async () => {
    await createCheckout(await reload(), "crew");
    const [params] = creates();
    expect(params!.consent_collection).toEqual({ terms_of_service: "required" });
    expect(params!.custom_text).toEqual({
      terms_of_service_acceptance: {
        message:
          "I agree to the [Terms of Service](https://app.example/terms) and the [Privacy Policy](https://app.example/privacy).",
      },
    });
    expect(await boxOffRow()).toBeUndefined();
  });

  it("no terms link in Stripe: the same checkout again without the box, a content-free warning, and the /admin note", async () => {
    fake.checkoutRefuses = (p) => (p.consent_collection ? noTermsUrl() : null);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const url = await createCheckout(await reload(), "crew");
    expect(url).toBe("https://checkout.example/cs");
    const [first, second] = creates();
    expect(creates()).toHaveLength(2);
    expect(second!.consent_collection).toBeUndefined();
    expect(second!.custom_text).toBeUndefined();
    // Otherwise the very same checkout (plan, setup fee, customer, links).
    const rest: Partial<Stripe.Checkout.SessionCreateParams> = { ...first! };
    delete rest.consent_collection;
    delete rest.custom_text;
    expect(second).toEqual(rest);
    expect(warned).toHaveBeenCalledWith("stripe_terms_url_missing", { workspaceId: workspace.id });
    expect(JSON.stringify(warned.mock.calls)).not.toMatch(/dashboard|owner@shop\.com|cus_/);
    expect(await boxOffRow()).toBeDefined();
    expect(await termsBoxOffSince()).toBeInstanceOf(Date);

    // Once the link is saved, the next checkout has the box again and the note goes.
    fake.checkoutRefuses = () => null;
    calls.length = 0;
    await createCheckout(await reload(), "solo");
    expect(creates()).toHaveLength(1);
    expect(creates()[0]!.consent_collection).toEqual({ terms_of_service: "required" });
    expect(await termsBoxOffSince()).toBeNull();
  });

  it("matched by the parameter, or by the words if Stripe names none", () => {
    expect(isTermsUrlMissingError(noTermsUrl())).toBe(true);
    expect(
      isTermsUrlMissingError(
        new Stripe.errors.StripeInvalidRequestError({
          message: "Set a terms of service URL in your public details first.",
        }),
      ),
    ).toBe(true);
    for (const other of [
      new Stripe.errors.StripeInvalidRequestError({
        message: "No such price: 'price_1'",
        param: "line_items[0][price]",
      }),
      new Stripe.errors.StripeAPIError({ message: "terms of service URL" }),
      new Error("terms of service URL"),
      null,
      "consent_collection",
    ])
      expect(isTermsUrlMissingError(other), String(other)).toBe(false);
  });

  it("any other Stripe error goes up exactly as before: one attempt, no retry, no note", async () => {
    for (const err of [
      new Stripe.errors.StripeInvalidRequestError({
        message: "No such customer: 'cus_SECRET'",
        param: "customer",
      }),
      new Stripe.errors.StripeConnectionError({ message: "socket hang up" }),
      new Stripe.errors.StripeCardError({ message: "card declined" }),
    ]) {
      calls.length = 0;
      fake.checkoutRefuses = () => err;
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(createCheckout(await reload(), "crew")).rejects.toBe(err);
      expect(creates()).toHaveLength(1);
      expect(warned).not.toHaveBeenCalled();
      expect(await boxOffRow()).toBeUndefined();
    }
  });

  it("a refusal of the retry too goes up (never a third try)", async () => {
    const second = new Stripe.errors.StripeConnectionError({ message: "socket hang up" });
    let n = 0;
    fake.checkoutRefuses = () => (++n === 1 ? noTermsUrl() : second);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(createCheckout(await reload(), "crew")).rejects.toBe(second);
    expect(creates()).toHaveLength(2);
  });

  it("the /admin Payments card shows the line from the database only", () => {
    expect(TERMS_BOX_OFF_LINE).toBe(
      "Terms box at checkout: off. Add your terms link in Stripe → Settings → Business → Public details.",
    );
    const admin = readFileSync("src/app/(app)/admin/page.tsx", "utf8");
    expect(admin).toContain("termsBoxOffSince(),");
    expect(admin).toContain("{TERMS_BOX_OFF_LINE}");
    // termsBoxOffSince reads app_settings and never asks Stripe.
    const billing = readFileSync("src/server/billing.ts", "utf8");
    const fn = billing.slice(billing.indexOf("export async function termsBoxOffSince"));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).not.toMatch(/stripe\(\)|\bs\./);
  });
});

describe("sales tax (Stripe Tax, Davi 2026-10-14)", () => {
  const sessionParams = () =>
    calls.find((c) => c.method === "checkout.sessions.create")!
      .args[0] as Stripe.Checkout.SessionCreateParams;

  it("with Stripe Tax active, checkout adds tax and collects the address it's based on", async () => {
    fake.tax = "active";
    await createCheckout(await reload(), "crew");
    const params = sessionParams();
    expect(params.automatic_tax).toEqual({ enabled: true });
    // We always pass an existing customer (made without an address): Checkout saves what it asks.
    expect(params.customer).toBe("cus_1");
    expect(params.customer_update).toEqual({ address: "auto", name: "auto" });
    expect(params.billing_address_collection).toBe("required");
    // Everything else is as without tax.
    expect(params.line_items).toHaveLength(2);
    expect(params.allow_promotion_codes).toBe(true);
  });

  it("without Stripe Tax, the checkout is exactly as before", async () => {
    for (const status of ["pending", "inactive_somehow"]) {
      calls.length = 0;
      fake.tax = status;
      await createCheckout(await reload(), "crew");
      expect(Object.keys(sessionParams()).sort()).toEqual(
        [
          "allow_promotion_codes",
          "cancel_url",
          "client_reference_id",
          "customer",
          "line_items",
          "metadata",
          "mode",
          "subscription_data",
          "success_url",
          // The "I agree" box (2026-10-15), not tax.
          "consent_collection",
          "custom_text",
        ].sort(),
      );
    }
  });

  it("if Stripe can't say whether tax is on, no checkout is made and the error goes up", async () => {
    // A real stripe-node error: its name is just "Error"; the class is in `type`.
    const err = new Stripe.errors.StripeConnectionError({
      message: "Stripe said cus_SECRET owner@shop.com",
    });
    fake.tax = err;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(createCheckout(await reload(), "crew")).rejects.toBe(err);
    expect(calls.some((c) => c.method === "checkout.sessions.create")).toBe(false);
    // Asked first: nothing was created in Stripe either.
    expect(calls.map((c) => c.method)).toEqual(["tax.settings.retrieve"]);
    expect((await reload()).stripeCustomerId).toBeNull();
    // Content-free log: the error's name and a fixed reason code, never its message.
    expect(logged).toHaveBeenCalledWith("stripe_tax_check_failed", {
      workspaceId: workspace.id,
      error: "Error",
      reason: "connection",
    });
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/SECRET|owner@shop\.com/);
  });

  it("a key that can't read the tax settings is logged as a key problem, not a blip", async () => {
    fake.tax = new Stripe.errors.StripePermissionError({
      message: "The provided key 'rk_live_SECRET' does not have the required permissions",
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(createCheckout(await reload(), "crew")).rejects.toBeInstanceOf(
      Stripe.errors.StripePermissionError,
    );
    expect(calls.map((c) => c.method)).toEqual(["tax.settings.retrieve"]);
    expect(logged).toHaveBeenCalledWith("stripe_tax_check_failed", {
      workspaceId: workspace.id,
      error: "Error",
      reason: "permission",
    });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("SECRET");
  });

  it("new prices are tax-exclusive (tax on top)", async () => {
    await createCheckout(await reload(), "crew");
    const created = calls.filter((c) => c.method === "prices.create");
    expect(created).toHaveLength(4);
    for (const c of created) {
      expect((c.args[0] as Stripe.PriceCreateParams).tax_behavior).toBe("exclusive");
    }
  });

  it("checkout never changes an existing price's tax behavior", async () => {
    fake.tax = "active";
    fake.prices = [
      { id: "price_setup", lookup_key: setupLookupKey(), tax_behavior: "unspecified" },
      ...(["solo", "crew", "company"] as const).map((p) => ({
        id: `price_${p}`,
        lookup_key: planLookupKey(p),
        tax_behavior: "unspecified",
      })),
    ];
    await createCheckout(await reload(), "crew");
    expect(calls.some((c) => c.method === "prices.update")).toBe(false);
    expect(calls.some((c) => c.method === "prices.create")).toBe(false);
  });

  it("Connect Stripe sets unspecified prices to exclusive and leaves the rest alone", async () => {
    fake.prices = [
      { id: "price_setup", lookup_key: setupLookupKey(), tax_behavior: "unspecified" },
      { id: "price_solo", lookup_key: planLookupKey("solo"), tax_behavior: "inclusive" },
      { id: "price_crew", lookup_key: planLookupKey("crew"), tax_behavior: "exclusive" },
      { id: "price_company", lookup_key: planLookupKey("company"), tax_behavior: null },
    ];
    await connectStripe();
    const updates = calls.filter((c) => c.method === "prices.update");
    expect(updates.map((c) => c.args)).toEqual([
      ["price_setup", { tax_behavior: "exclusive" }],
      ["price_company", { tax_behavior: "exclusive" }],
    ]);
    expect(calls.some((c) => c.method === "prices.create")).toBe(false);
  });

  it("Connect Stripe makes missing prices exclusive", async () => {
    fake.prices = [{ id: "price_setup", lookup_key: setupLookupKey(), tax_behavior: "exclusive" }];
    await connectStripe();
    expect(calls.some((c) => c.method === "prices.update")).toBe(false);
    const created = calls.filter((c) => c.method === "prices.create");
    expect(created).toHaveLength(3);
    for (const c of created) {
      expect((c.args[0] as Stripe.PriceCreateParams).tax_behavior).toBe("exclusive");
    }
  });

  it("a new customer portal lets owners fix their billing address; an existing one is left alone", async () => {
    await connectStripe();
    const create = calls.find((c) => c.method === "billingPortal.configurations.create")!;
    const features = (create.args[0] as Stripe.BillingPortal.ConfigurationCreateParams).features;
    expect(features.customer_update).toEqual({ enabled: true, allowed_updates: ["address"] });
    expect(features.subscription_cancel).toEqual({ enabled: true, mode: "at_period_end" });

    calls.length = 0;
    fake.portals = 1;
    await connectStripe();
    expect(calls.some((c) => c.method === "billingPortal.configurations.create")).toBe(false);
  });

  it("the /admin line: on, off, couldn't check (content-free, never throws)", async () => {
    fake.tax = "active";
    expect(await salesTaxStatus()).toBe("on");
    fake.tax = "pending";
    expect(await salesTaxStatus()).toBe("off");

    fake.tax = new Stripe.errors.StripeAuthenticationError({
      message: "Invalid API Key provided: sk_test_SECRET",
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await salesTaxStatus()).toBe("unknown");
    // The reason code says it's the key (stripe-node errors are all named "Error").
    expect(logged).toHaveBeenCalledWith("stripe_tax_status_failed", {
      error: "Error",
      reason: "auth",
    });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("SECRET");
    // A short wait at most: the admin page never hangs on Stripe.
    const opts = calls.filter((c) => c.method === "tax.settings.retrieve").at(-1)!.args[1];
    expect(opts).toMatchObject({ timeout: 5_000 });

    expect(SALES_TAX_LINES).toEqual({
      on: "Sales tax: on (Stripe Tax is set up).",
      off: "Sales tax: off. Set up Stripe Tax in Stripe to charge it.",
      unknown: "Sales tax: couldn't check.",
    });
    // "Active" at Stripe only needs the business address; tax is charged where registered.
    expect(SALES_TAX_ON_NOTE).toBe(
      "Stripe only charges it in the states listed in Stripe under Tax → Registrations.",
    );
  });

  it("the /admin line isn't shown, and Stripe isn't asked, when Stripe isn't set up", async () => {
    setStripeForTests(undefined);
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    try {
      expect(await salesTaxStatus()).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(calls).toHaveLength(0);
  });

  it("owners see the tax note next to the prices (homepage and /billing); admin shows the line", () => {
    expect(SALES_TAX_NOTE).toBe("Plus sales tax where it applies.");
    for (const f of ["src/app/page.tsx", "src/app/(app)/billing/page.tsx"]) {
      expect(readFileSync(f, "utf8"), f).toContain("{SALES_TAX_NOTE}");
    }
    const admin = readFileSync("src/app/(app)/admin/page.tsx", "utf8");
    expect(admin).toContain("{salesTax ? <p>{SALES_TAX_LINES[salesTax]}</p> : null}");
  });
});

describe("webhook-driven status", () => {
  it("a real setup payment records its own date, not a hand-marked or test-card one", async () => {
    const OLD = new Date("2026-10-01T09:00:00Z");
    // Hand-marked before 2026-10-10, or reset after a test card: a date, but nothing paid.
    await database
      .update(workspaces)
      .set({ status: "setup_paid", setupPaidAt: OLD, setupPaidVia: null })
      .where(eq(workspaces.id, workspace.id));
    await applyCheckoutCompleted(paidSession(), NOW);
    expect((await reload()).setupPaidAt?.toISOString()).toBe(NOW.toISOString());
    // A second webhook for an already real payment keeps the first date.
    await applyCheckoutCompleted(paidSession({ id: "cs_2" }), new Date(NOW.getTime() + 60_000));
    expect((await reload()).setupPaidAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("a paid checkout turns sending on and records the plan and setup fee", async () => {
    expect(await applyCheckoutCompleted(paidSession(), NOW)).toBe("applied");
    const after = await reload();
    expect(after.status).toBe("setup_paid");
    expect(after.plan).toBe("crew");
    expect(after.stripeSubscriptionId).toBe("sub_1");
    expect(after.setupPaidAt?.toISOString()).toBe(NOW.toISOString());
    expect(after.setupPaidVia).toBe("stripe");
    expect(canSend(after)).toBe(true);
    const logs = await database.select().from(activityLog);
    expect(logs.map((l) => l.action)).toContain("payment_received");
  });

  it("an unpaid checkout changes nothing", async () => {
    expect(await applyCheckoutCompleted(paidSession({ payment_status: "unpaid" }), NOW)).toBe(
      "ignored",
    );
    expect((await reload()).status).toBe("evaluating");
  });

  it("past due pauses work; recovered resumes; canceled ends and allows a new checkout", async () => {
    await applyCheckoutCompleted(paidSession(), NOW);
    await applySubscription(subscription("past_due"), NOW);
    expect((await reload()).status).toBe("past_due");
    expect(canSend(await reload())).toBe(false);

    await applySubscription(subscription("active", "company"), NOW);
    const back = await reload();
    expect(back.status).toBe("setup_paid");
    expect(back.plan).toBe("company");

    await applySubscription(subscription("canceled"), NOW);
    const ended = await reload();
    expect(ended.status).toBe("canceled");
    expect(ended.stripeSubscriptionId).toBeNull();
    expect(checkoutTerms(ended, NOW)).toEqual({ allowed: true, includeSetupFee: false });
  });
});

describe("webhook endpoint", () => {
  const event = (id: string, type: string, object: unknown) =>
    JSON.stringify({ id, type, data: { object } });

  it("rejects a bad signature and changes nothing", async () => {
    const r = await handleStripeWebhook(
      event("evt_1", "checkout.session.completed", paidSession()),
      "forged",
    );
    expect(r.status).toBe(400);
    expect((await reload()).status).toBe("evaluating");
    expect(await database.select().from(stripeEvents)).toHaveLength(0);
  });

  it("rejects a missing signature", async () => {
    const r = await handleStripeWebhook("{}", null);
    expect(r.status).toBe(400);
  });

  it("handles each event once", async () => {
    const body = event("evt_1", "checkout.session.completed", paidSession());
    expect((await handleStripeWebhook(body, "good")).status).toBe(200);
    expect((await reload()).status).toBe("setup_paid");

    // Admin moves the account on; a replay of the same event must not undo it.
    await database
      .update(workspaces)
      .set({ status: "paused" })
      .where(eq(workspaces.id, workspace.id));
    const again = await handleStripeWebhook(body, "good");
    expect(again).toEqual({ status: 200, body: "Already handled." });
    expect((await reload()).status).toBe("paused");
    const logs = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "payment_received"));
    expect(logs).toHaveLength(1);
  });

  it("forgets an event that failed so Stripe's retry is processed", async () => {
    const body = event("evt_2", "customer.subscription.updated", {
      ...subscription("past_due"),
      items: null, // malformed → throws inside the handler
    });
    await expect(handleStripeWebhook(body, "good")).rejects.toThrow();
    expect(await database.select().from(stripeEvents)).toHaveLength(0);
  });

  it("GUARDRAIL: with the live key, test-mode events change nothing (and the other way round)", async () => {
    // After the switch to live, the stored secret is the test endpoint's until Connect Stripe
    // runs again (LAUNCH.md 7b): a late test checkout or a test renewal must not put a test
    // payment back on an account "Reset test payments" cleared.
    const modeEvent = (id: string, type: string, object: unknown, livemode: boolean) =>
      JSON.stringify({ id, type, livemode, data: { object } });
    const before = await reload();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_" + "live_" + "fake");
    try {
      for (const [id, type, object] of [
        ["evt_t1", "checkout.session.completed", paidSession()],
        ["evt_t2", "customer.subscription.updated", subscription("past_due")],
      ] as const) {
        expect(await handleStripeWebhook(modeEvent(id, type, object, false), "good")).toEqual({
          status: 200,
          body: "Ignored: other Stripe mode.",
        });
      }
      const after = await reload();
      expect(after).toMatchObject({
        status: before.status,
        setupPaidVia: null,
        stripeCustomerId: before.stripeCustomerId,
        stripeSubscriptionId: null,
      });
      expect(canSend(after)).toBe(false);
      expect(await database.select().from(stripeEvents)).toHaveLength(0);
      expect(info).toHaveBeenCalledWith("stripe_event_other_mode", { livemode: false });

      // A live event is handled as always.
      const live = modeEvent("evt_l1", "checkout.session.completed", paidSession(), true);
      expect((await handleStripeWebhook(live, "good")).status).toBe(200);
      expect((await reload()).setupPaidVia).toBe("stripe");

      // A test key ignores live events.
      vi.stubEnv("STRIPE_SECRET_KEY", "sk_" + "test_" + "fake");
      const liveSub = modeEvent(
        "evt_l2",
        "customer.subscription.updated",
        subscription("past_due"),
        true,
      );
      expect((await handleStripeWebhook(liveSub, "good")).body).toBe("Ignored: other Stripe mode.");
      expect((await reload()).status).toBe("setup_paid");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("STRIPE_WEBHOOK_SECRET overrides the stored secret", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_other";
    const r = await handleStripeWebhook(event("evt_3", "x.y", {}), "good");
    expect(r.status).toBe(400);
  });
});

describe("plan #47 §1.9: the webhook reads the live subscription", () => {
  const event = (id: string, type: string, object: unknown) =>
    JSON.stringify({ id, type, data: { object } });
  const priceOf = (plan: "solo" | "crew" | "company") => `price_${plan}`;

  beforeEach(async () => {
    for (const plan of ["solo", "crew", "company"] as const)
      fake.addPrice({
        id: priceOf(plan),
        lookup_key: planLookupKey(plan),
        unit_amount: pricing.plans[plan].amountCents,
      });
    await database
      .update(workspaces)
      .set({
        status: "active",
        setupPaidVia: "stripe",
        setupPaidAt: NOW,
        plan: "crew",
        stripeCustomerId: "cus_1",
        stripeSubscriptionId: "sub_1",
      })
      .where(eq(workspaces.id, workspace.id));
    fake.addSubscription({
      id: "sub_1",
      customer: "cus_1",
      price: priceOf("crew"),
      workspaceId: workspace.id,
    });
  });

  /** What an event carries: a snapshot that may be older than Stripe's live state. */
  const snapshot = (plan: "solo" | "crew" | "company", status = "active") =>
    ({
      id: "sub_1",
      status,
      metadata: { workspaceId: workspace.id },
      items: { data: [{ price: { lookup_key: planLookupKey(plan) } }] },
    }) as unknown as Stripe.Subscription;

  /** Three inboxes, created in this order (the plan's limit ranks by when each was added). */
  async function threeInboxes() {
    const ids: string[] = [];
    for (const [i, email] of ["owner@shop.com", "office@shop.com", "crew@shop.com"].entries()) {
      const box = await saveConnectedMailbox(
        { id: workspace.id, plan: "company", freePlan: null, freePlanUntil: null },
        { email, refreshToken: "rt", grantedScopes: [] },
      );
      await database
        .update(mailboxes)
        .set({ createdAt: new Date(NOW.getTime() - (3 - i) * 86_400_000) })
        .where(eq(mailboxes.id, box.id));
      ids.push(box.id);
    }
    return ids;
  }
  const boxes = async () =>
    Object.fromEntries(
      (await database.select().from(mailboxes)).map((m) => [
        m.email,
        [m.status, m.planPausedAt !== null],
      ]),
    );
  const actions = async () =>
    (await database.select().from(activityLog)).map((l) => [l.action, l.detail]);

  it("a late, stale event can't put the plan back: status and plan come from the fresh read", async () => {
    // Stripe already moved the subscription to Company; the older Crew-era event arrives last.
    fake.sub("sub_1").items.data[0]!.price = fake.price(priceOf("company"));
    expect(
      (
        await handleStripeWebhook(
          event("evt_old", "customer.subscription.updated", snapshot("solo")),
          "good",
        )
      ).status,
    ).toBe(200);
    expect((await reload()).plan).toBe("company");
    const read = calls.find((c) => c.method === "subscriptions.retrieve");
    expect(read?.args).toEqual(["sub_1", { expand: ["discounts"] }]);
  });

  it("a subscription Stripe no longer has falls back to the event's own copy", async () => {
    fake.subscriptions.delete("sub_1");
    await applySubscription(snapshot("crew", "canceled"), NOW);
    const after = await reload();
    expect(after.status).toBe("canceled");
    expect(after.stripeSubscriptionId).toBeNull();
  });

  it("Stripe can't be read (5xx): the webhook fails and is forgotten, so Stripe retries it", async () => {
    fake.failNext("subscriptions.retrieve", stripeErrors.api());
    const body = event("evt_5xx", "customer.subscription.updated", snapshot("solo", "past_due"));
    await expect(handleStripeWebhook(body, "good")).rejects.toThrow();
    expect(await database.select().from(stripeEvents)).toHaveLength(0);
    expect((await reload()).status).toBe("active");
    // Stripe's retry goes through.
    fake.sub("sub_1").status = "past_due";
    expect((await handleStripeWebhook(body, "good")).status).toBe(200);
    expect((await reload()).status).toBe("past_due");
  });

  it("records when the plan is set to end, and clears it when renewal is back on or it ended", async () => {
    const sub = fake.sub("sub_1");
    sub.cancel_at_period_end = true;
    await applySubscription(snapshot("crew"), NOW);
    expect((await reload()).stripeCancelAt?.getTime()).toBe(
      sub.items.data[0]!.current_period_end * 1000,
    );
    sub.cancel_at_period_end = false;
    sub.cancel_at = Math.floor(NOW.getTime() / 1000) + 3 * 86_400;
    await applySubscription(snapshot("crew"), NOW);
    expect((await reload()).stripeCancelAt?.getTime()).toBe(sub.cancel_at * 1000);
    sub.cancel_at = null;
    await applySubscription(snapshot("crew"), NOW);
    expect((await reload()).stripeCancelAt).toBeNull();
    sub.cancel_at = Math.floor(NOW.getTime() / 1000);
    sub.status = "canceled";
    await applySubscription(snapshot("crew", "canceled"), NOW);
    expect((await reload()).stripeCancelAt).toBeNull();
  });

  it("Q2: a move down on Stripe's page turns autopilot off and pauses the newest extra inboxes", async () => {
    const [first, second, third] = await threeInboxes();
    await database.insert(rules).values([
      { workspaceId: workspace.id, category: "scheduling", mode: "autopilot" },
      { workspaceId: workspace.id, category: "quote_request", mode: "draft" },
    ]);
    // A countdown running on the first inbox (autopilot) must stop too.
    const [t] = await database
      .insert(threads)
      .values({ mailboxId: first!, gmailThreadId: "g1", inInbox: true, category: "scheduling" })
      .returning();
    const [d] = await database
      .insert(drafts)
      .values({
        threadId: t!.id,
        mailboxId: first!,
        toAddress: "dana@x.com",
        subject: "Re: Tuesday",
        body: "Tuesday works.",
        originalBody: "Tuesday works.",
        reason: "Confirms the time.",
        autoSendAt: new Date(NOW.getTime() + 600_000),
      })
      .returning();

    fake.portalChange("sub_1", priceOf("solo"));
    await handleStripeWebhook(
      event("evt_down", "customer.subscription.updated", snapshot("solo")),
      "good",
    );

    expect((await reload()).plan).toBe("solo");
    expect((await database.select().from(rules)).map((r) => [r.category, r.mode]).sort()).toEqual([
      ["quote_request", "draft"],
      ["scheduling", "draft"],
    ]);
    const [after] = await database.select().from(drafts).where(eq(drafts.id, d!.id));
    expect(after!.autoSendAt).toBeNull();
    // Solo includes 1 inbox: the first-created stays on, nothing is deleted.
    expect(await boxes()).toEqual({
      "owner@shop.com": ["active", false],
      "office@shop.com": ["active", true],
      "crew@shop.com": ["active", true],
    });
    expect(second && third).toBeTruthy();
    const log = await actions();
    expect(log).toContainEqual(["autopilot_turned_off_plan", { count: 1 }]);
    expect(log).toContainEqual(["mailboxes_fit_plan", { paused: 2, resumed: 0, limit: 1 }]);

    // Moving back up (Crew includes 3) switches them on again.
    fake.portalChange("sub_1", priceOf("crew"));
    await applySubscription(snapshot("crew"), NOW);
    expect(Object.values(await boxes())).toEqual([
      ["active", false],
      ["active", false],
      ["active", false],
    ]);
    expect(await actions()).toContainEqual([
      "mailboxes_fit_plan",
      { paused: 0, resumed: 2, limit: 3 },
    ]);
  });

  it("any event fits the inboxes to the plan (as the 15-minute backstop would anyway)", async () => {
    // Since the referral merge both sides share the decisions package's plan pause, whose
    // `fitAllMailboxesToPlans` step fits every account every 15 minutes: an account already over
    // its limit is paused by the next event (e.g. a card update) instead of waiting for it.
    await database.update(workspaces).set({ plan: "solo" }).where(eq(workspaces.id, workspace.id));
    fake.sub("sub_1").items.data[0]!.price = fake.price(priceOf("solo"));
    await threeInboxes();
    await applySubscription(snapshot("solo"), NOW); // e.g. a card update
    expect(await boxes()).toEqual({
      "owner@shop.com": ["active", false],
      "office@shop.com": ["active", true],
      "crew@shop.com": ["active", true],
    });
  });

  for (const order of ["checkout first", "subscription first"] as const) {
    it(`Q2: a canceled Crew owner who comes back on Solo has the extras paused (${order})`, async () => {
      await threeInboxes();
      await database
        .insert(rules)
        .values({ workspaceId: workspace.id, category: "scheduling", mode: "autopilot" });
      await database
        .update(workspaces)
        .set({ status: "canceled", stripeSubscriptionId: null })
        .where(eq(workspaces.id, workspace.id));
      fake.subscriptions.delete("sub_1");
      fake.addSubscription({
        id: "sub_2",
        customer: "cus_1",
        price: priceOf("solo"),
        workspaceId: workspace.id,
      });
      const checkout = () =>
        applyCheckoutCompleted(
          paidSession({
            id: "cs_back",
            subscription: "sub_2",
            metadata: { workspaceId: workspace.id, plan: "solo", includesSetup: "0" },
          }),
          NOW,
        );
      const created = () =>
        applySubscription({ ...snapshot("solo"), id: "sub_2" } as Stripe.Subscription, NOW);
      if (order === "checkout first") {
        await checkout();
        await created();
      } else {
        await created();
        await checkout();
      }
      expect((await reload()).plan).toBe("solo");
      expect(await boxes()).toEqual({
        "owner@shop.com": ["active", false],
        "office@shop.com": ["active", true],
        "crew@shop.com": ["active", true],
      });
      expect((await database.select().from(rules))[0]!.mode).toBe("draft");
      expect((await actions()).filter(([a]) => a === "mailboxes_fit_plan")).toEqual([
        ["mailboxes_fit_plan", { paused: 2, resumed: 0, limit: 1 }],
      ]);
    });
  }

  it("a move down during a running free month keeps the free plan's inboxes and autopilot", async () => {
    await database
      .update(workspaces)
      .set({ freePlan: "company", freePlanUntil: new Date(NOW.getTime() + 10 * 86_400_000) })
      .where(eq(workspaces.id, workspace.id));
    await threeInboxes();
    await database
      .insert(rules)
      .values({ workspaceId: workspace.id, category: "scheduling", mode: "autopilot" });
    fake.portalChange("sub_1", priceOf("solo"));
    await applySubscription(snapshot("solo"), NOW);
    expect((await reload()).plan).toBe("solo");
    expect(Object.values(await boxes()).every(([, paused]) => paused === false)).toBe(true);
    expect((await database.select().from(rules))[0]!.mode).toBe("autopilot");
  });
});

describe("plan #47 Q3: during a free month, Stripe's page has no plan changes", () => {
  const TEST_KEY = "sk_" + "test_" + "fake";
  const freeMonth = async (running: boolean) => {
    await database
      .update(workspaces)
      .set({
        status: "active",
        plan: "solo",
        stripeCustomerId: "cus_1",
        freePlan: running ? "crew" : null,
        freePlanUntil: running ? new Date(Date.now() + 5 * 86_400_000) : null,
      })
      .where(eq(workspaces.id, workspace.id));
    return (await reload())!;
  };
  const sessions = () => calls.filter((c) => c.method === "billingPortal.sessions.create");
  const cached = async (mode: "live" | "test" = "test") =>
    (
      await database
        .select()
        .from(appSettings)
        .where(eq(appSettings.key, NO_PLAN_CHANGE_PORTAL_KEY(mode)))
    )[0];

  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", TEST_KEY);
    fake.addPortalConfiguration({ id: "bpc_default" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("no free month: the default page, nothing made", async () => {
    await createPortal(await freeMonth(false));
    expect(sessions()[0]!.args[0]).not.toHaveProperty("configuration");
    expect(calls.some((c) => c.method === "billingPortal.configurations.create")).toBe(false);
  });

  it("running: built from the default with only plan changes off, cached per mode, reused", async () => {
    const w = await freeMonth(true);
    await createPortal(w);
    const created = calls.find((c) => c.method === "billingPortal.configurations.create")!;
    const params = created.args[0] as Stripe.BillingPortal.ConfigurationCreateParams;
    expect(params.features.subscription_update).toEqual({ enabled: false });
    expect(params.features.subscription_cancel).toMatchObject({ enabled: true });
    expect(params.features.payment_method_update).toEqual({ enabled: true });
    expect(params.features.invoice_history).toEqual({ enabled: true });
    expect(params.login_page).toEqual({ enabled: false });
    expect(sessions()[0]!.args[0]).toMatchObject({ configuration: "bpc_new" });
    expect(JSON.parse((await cached())!.value)).toMatchObject({ id: "bpc_new" });
    expect(await cached("live")).toBeUndefined();
    // Again: retrieved and reused, nothing made or changed.
    calls.length = 0;
    await createPortal(w);
    expect(calls.map((c) => c.method)).not.toContain("billingPortal.configurations.create");
    expect(calls.map((c) => c.method)).not.toContain("billingPortal.configurations.update");
    expect(sessions()[0]!.args[0]).toMatchObject({ configuration: "bpc_new" });
  });

  it("rebuilt when Davi changes the default; made again when Stripe lost it", async () => {
    const w = await freeMonth(true);
    await createPortal(w);
    fake.advance(60_000);
    const def = (await fake.client.billingPortal.configurations.retrieve("bpc_default")) as {
      updated: number;
    };
    await fake.client.billingPortal.configurations.update("bpc_default", {
      features: { invoice_history: { enabled: false } },
    });
    expect(
      (await fake.client.billingPortal.configurations.retrieve("bpc_default")).updated,
    ).toBeGreaterThan(def.updated);
    calls.length = 0;
    await createPortal(w);
    const update = calls.find(
      (c) => c.method === "billingPortal.configurations.update" && c.args[0] === "bpc_new",
    )!;
    expect(update.args[1]).toMatchObject({
      active: true,
      features: { invoice_history: { enabled: false }, subscription_update: { enabled: false } },
    });
    // Stripe no longer has ours: made again, and the cache follows.
    await database
      .update(appSettings)
      .set({ value: JSON.stringify({ id: "bpc_gone", defaultUpdated: 0 }) })
      .where(eq(appSettings.key, NO_PLAN_CHANGE_PORTAL_KEY("test")));
    calls.length = 0;
    await createPortal(w);
    expect(calls.map((c) => c.method)).toContain("billingPortal.configurations.create");
    expect(JSON.parse((await cached())!.value)).toMatchObject({ id: "bpc_new" });
  });

  it("if the settings can't be made, the default page still opens (card and cancel)", async () => {
    const w = await freeMonth(true);
    fake.failNext("billingPortal.configurations.create", stripeErrors.api());
    vi.spyOn(console, "error").mockImplementation(() => {});
    const url = await createPortal(w);
    expect(url).toMatch(/^https:\/\/billing\.example\//);
    expect(sessions()[0]!.args[0]).not.toHaveProperty("configuration");
  });

  it("the copy from the default never carries plan changes or the login page", () => {
    const params = noPlanChangePortalParams({
      id: "bpc_x",
      updated: 1,
      default_return_url: "https://app.example/billing",
      business_profile: { headline: "Hi", privacy_policy_url: null, terms_of_service_url: null },
      login_page: { enabled: true, url: "https://billing.stripe.com/p/login/x" },
      features: {
        customer_update: { enabled: true, allowed_updates: ["address"] },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true, payment_method_configuration: null },
        subscription_cancel: {
          enabled: true,
          mode: "at_period_end",
          proration_behavior: "none",
          cancellation_reason: { enabled: false, options: [] },
        },
        subscription_update: {
          enabled: true,
          default_allowed_updates: ["price"],
          proration_behavior: "create_prorations",
        },
      },
    } as unknown as Stripe.BillingPortal.Configuration);
    expect(params).toEqual({
      business_profile: { headline: "Hi" },
      default_return_url: "https://app.example/billing",
      features: {
        customer_update: { enabled: true, allowed_updates: ["address"] },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: {
          enabled: true,
          mode: "at_period_end",
          proration_behavior: "none",
          cancellation_reason: { enabled: false, options: "" },
        },
        subscription_update: { enabled: false },
      },
      login_page: { enabled: false },
      metadata: { purpose: "referral_free_month_no_plan_change" },
    });
  });
});

describe("plan #47: /admin never shows silence for an unread billing page", () => {
  it("a failed read is 'unknown' and the card says so; a readable one says it's clear", async () => {
    fake.addPortalConfiguration({ id: "bpc_default" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.failNext("billingPortal.configurations.list", stripeErrors.api());
    expect(await portalStatus()).toBe("unknown");
    expect(await portalStatus()).toEqual({ schedulesDowngrades: false, loginPage: false });
    const admin = readFileSync("src/app/(app)/admin/page.tsx", "utf8");
    expect(admin).toMatch(
      /portal === "unknown" \? \(\s*<p className="font-semibold">\{PORTAL_UNKNOWN_LINE\}<\/p>/,
    );
    expect(admin).toContain("<p>{PORTAL_DOWNGRADES_NOW_LINE}</p>");
    expect(readFileSync("docs/SETUP.md", "utf8")).toContain(
      "Stripe's billing page changes plans straight away, so free months\n   can be booked.",
    );
  });
});

describe("plan #47 Q2: Plan & billing says what moving down pauses, before the tap", () => {
  it("counts only, for each lower plan that would pause any", () => {
    expect(downgradePausesLine("crew", 3)).toBe(
      "Moving to Solo pauses 2 of your 3 inboxes. Nothing is deleted, and you choose which stay on in Settings.",
    );
    expect(downgradePausesLine("company", 5)).toBe(
      "Moving to Crew pauses 2 of your 5 inboxes; to Solo, 4. Nothing is deleted, and you choose which stay on in Settings.",
    );
    expect(downgradePausesLine("company", 2)).toBe(
      "Moving to Solo pauses 1 of your 2 inboxes. Nothing is deleted, and you choose which stay on in Settings.",
    );
    expect(downgradePausesLine("crew", 1)).toBeNull();
    expect(downgradePausesLine("solo", 3)).toBeNull();
    expect(downgradePausesLine(null, 3)).toBeNull();
  });

  it("is shown under Manage billing outside a free month", () => {
    const page = readFileSync("src/app/(app)/billing/page.tsx", "utf8");
    expect(page).toContain("!running && workspace.stripeCustomerId");
    expect(page).toContain(
      '{downgradeLine ? <p className="text-sm font-semibold">{downgradeLine}</p> : null}',
    );
  });
});
