import "server-only";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { pricing, type PlanId } from "@/config/pricing";
import { db } from "@/db";
import {
  activityLog,
  appSettings,
  stripeEvents,
  users,
  workspaces,
  type Workspace,
} from "@/db/schema";
import { appUrl } from "@/lib/app-url";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import {
  checkoutTerms,
  isPlanId,
  PLAN_IDS,
  planFromLookupKey,
  planLookupKey,
  type SalesTaxStatus,
  setupLookupKey,
  statusAfterCheckout,
  statusAfterSubscription,
} from "./billing-rules";
import { creditReferralSafely } from "./referrals";
import { stripeErrorReason } from "./stripe-error-rules";

let client: Stripe | undefined;
let override: Stripe | undefined;

/** Tests swap in a fake. */
export function setStripeForTests(fake: Stripe | undefined) {
  override = fake;
}

export function stripeConfigured() {
  return Boolean(override || process.env.STRIPE_SECRET_KEY);
}

function stripe(): Stripe {
  if (override) return override;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set.");
  client ??= new Stripe(key);
  return client;
}

/** The one Stripe client (or the test fake), for other server modules (plan #47 credits). */
export function stripeClient(): Stripe {
  return stripe();
}

export const WEBHOOK_PATH = "/api/stripe/webhook";
const WEBHOOK_SECRET_KEY = "stripe_webhook_secret";
const WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
];

/**
 * Whether Stripe Tax is switched on (Davi, 2026-10-14). Davi sets it up in Stripe's dashboard
 * (origin address, registrations, default tax code); the app only notices. Throws when Stripe
 * can't be asked — callers decide what that means.
 */
export async function stripeTaxActive(options?: Stripe.RequestOptions): Promise<boolean> {
  const settings = await stripe().tax.settings.retrieve({}, options);
  return settings.status === "active";
}

/** For the /admin Payments card: null without Stripe; never throws, never waits long. */
export async function salesTaxStatus(): Promise<SalesTaxStatus | null> {
  if (!stripeConfigured()) return null;
  try {
    return (await stripeTaxActive({ timeout: 5_000, maxNetworkRetries: 0 })) ? "on" : "off";
  } catch (err) {
    // stripe-node's errors all have the name "Error"; the class is in `type`, so the fixed
    // reason code is what tells a key problem (auth, permission) from a blip (connection).
    const reason = stripeErrorReason(err);
    console.error("stripe_tax_status_failed", {
      error: err instanceof Error ? err.name : "unknown",
      reason,
    });
    return "unknown";
  }
}

/** Prices are tax-exclusive: sales tax, where it applies, goes on top ("plus any taxes"). */
const TAX_BEHAVIOR = "exclusive" as const;

/**
 * Find or create our four prices by lookup key (the key includes the amount,
 * so changing src/config/pricing.ts creates a new price rather than editing
 * one customers are on). New prices are tax-exclusive. With `fixTaxBehavior`
 * (Connect Stripe only), a found price that never had a tax behavior is set to
 * exclusive — the one change Stripe allows; a price already inclusive or
 * exclusive is never touched.
 */
export async function ensurePrices({ fixTaxBehavior = false } = {}): Promise<{
  setup: string;
  plans: Record<PlanId, string>;
}> {
  const s = stripe();
  const wanted = [
    {
      key: setupLookupKey(),
      name: `Squared Away — ${pricing.setupFee.name}`,
      amount: pricing.setupFee.amountCents,
      recurring: false,
    },
    ...PLAN_IDS.map((plan) => ({
      key: planLookupKey(plan),
      name: `Squared Away — ${pricing.plans[plan].name}`,
      amount: pricing.plans[plan].amountCents,
      recurring: true,
    })),
  ];
  const found = await s.prices.list({
    lookup_keys: wanted.map((w) => w.key),
    active: true,
    limit: 10,
  });
  const byKey = new Map(found.data.map((p) => [p.lookup_key, p.id]));
  if (fixTaxBehavior) {
    for (const p of found.data) {
      if (p.tax_behavior && p.tax_behavior !== "unspecified") continue;
      await s.prices.update(p.id, { tax_behavior: TAX_BEHAVIOR });
    }
  }
  for (const w of wanted) {
    if (byKey.has(w.key)) continue;
    const price = await s.prices.create({
      currency: "usd",
      unit_amount: w.amount,
      lookup_key: w.key,
      transfer_lookup_key: true,
      tax_behavior: TAX_BEHAVIOR,
      product_data: { name: w.name },
      ...(w.recurring ? { recurring: { interval: "month" as const } } : {}),
    });
    byKey.set(w.key, price.id);
  }
  return {
    setup: byKey.get(setupLookupKey())!,
    plans: Object.fromEntries(PLAN_IDS.map((p) => [p, byKey.get(planLookupKey(p))!])) as Record<
      PlanId,
      string
    >,
  };
}

/**
 * Davi's one-tap "Connect Stripe" in /admin: prices, the customer billing
 * portal, and the webhook (its signing secret is stored encrypted). Safe to
 * run again — it reuses what exists and replaces our webhook.
 */
export async function connectStripe(): Promise<{
  prices: number;
  webhookUrl: string;
  mode: string;
}> {
  const s = stripe();
  const prices = await ensurePrices({ fixTaxBehavior: true });

  const portals = await s.billingPortal.configurations.list({ is_default: true, limit: 1 });
  if (!portals.data.length) {
    const products = await Promise.all(
      PLAN_IDS.map(async (p) => {
        const price = await s.prices.retrieve(prices.plans[p]);
        return { product: price.product as string, prices: [price.id] };
      }),
    );
    await s.billingPortal.configurations.create({
      business_profile: { headline: "Squared Away — manage your plan and payment." },
      features: {
        // The billing address Stripe Tax works from: the owner can correct it here.
        customer_update: { enabled: true, allowed_updates: ["address"] },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true, mode: "at_period_end" },
        subscription_update: {
          enabled: true,
          default_allowed_updates: ["price"],
          proration_behavior: "create_prorations",
          products,
        },
      },
    });
  }

  const url = appUrl(WEBHOOK_PATH);
  const existing = await s.webhookEndpoints.list({ limit: 100 });
  for (const e of existing.data) if (e.url === url) await s.webhookEndpoints.del(e.id);
  const endpoint = await s.webhookEndpoints.create({
    url,
    enabled_events: WEBHOOK_EVENTS,
    description: "Squared Away: payments drive account status",
  });
  if (endpoint.secret) {
    const value = encryptSecret(endpoint.secret);
    await db()
      .insert(appSettings)
      .values({ key: WEBHOOK_SECRET_KEY, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  }
  return {
    prices: 1 + PLAN_IDS.length,
    webhookUrl: url,
    mode: process.env.STRIPE_SECRET_KEY?.startsWith("sk_live") ? "live" : "test",
  };
}

/** When Connect Stripe last succeeded (the stored webhook secret), or null if never. */
export async function stripeConnectedAt(): Promise<Date | null> {
  const [row] = await db()
    .select({ updatedAt: appSettings.updatedAt })
    .from(appSettings)
    .where(eq(appSettings.key, WEBHOOK_SECRET_KEY));
  return row?.updatedAt ?? null;
}

async function webhookSecret(): Promise<string | null> {
  if (process.env.STRIPE_WEBHOOK_SECRET) return process.env.STRIPE_WEBHOOK_SECRET;
  const [row] = await db()
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, WEBHOOK_SECRET_KEY));
  return row ? decryptSecret(row.value) : null;
}

export class CheckoutNotAllowedError extends Error {
  constructor() {
    super("This account already has a plan. Use Manage billing instead.");
    this.name = "CheckoutNotAllowedError";
  }
}

/** Stripe Checkout for the plan (plus the one-time setup fee if it hasn't been paid). */
export async function createCheckout(workspace: Workspace, plan: PlanId): Promise<string> {
  const terms = checkoutTerms(workspace);
  if (!terms.allowed) throw new CheckoutNotAllowedError();
  const s = stripe();
  // Asked first, so nothing is created in Stripe when it can't answer. A failure fails the
  // checkout (never an untaxed one once tax might be on).
  let taxOn: boolean;
  try {
    taxOn = await stripeTaxActive();
  } catch (err) {
    const reason = stripeErrorReason(err);
    console.error("stripe_tax_check_failed", {
      workspaceId: workspace.id,
      error: err instanceof Error ? err.name : "unknown",
      reason,
    });
    throw err;
  }
  const prices = await ensurePrices();
  const [owner] = await db().select().from(users).where(eq(users.id, workspace.ownerUserId));

  let customer = workspace.stripeCustomerId;
  if (!customer) {
    const c = await s.customers.create({
      email: owner?.email,
      name: workspace.businessName ?? owner?.name ?? undefined,
      metadata: { workspaceId: workspace.id },
    });
    customer = c.id;
    await db()
      .update(workspaces)
      .set({ stripeCustomerId: customer })
      .where(eq(workspaces.id, workspace.id));
  }

  const metadata = {
    workspaceId: workspace.id,
    plan,
    includesSetup: terms.includeSetupFee ? "1" : "0",
  };
  // Stripe Tax works from the customer's address. Ours are created without one, so Checkout
  // collects it and saves it (and the name with it) onto the customer.
  const tax: Partial<Stripe.Checkout.SessionCreateParams> = taxOn
    ? {
        automatic_tax: { enabled: true },
        customer_update: { address: "auto", name: "auto" },
        billing_address_collection: "required",
      }
    : {};
  const session = await s.checkout.sessions.create({
    mode: "subscription",
    customer,
    client_reference_id: workspace.id,
    line_items: [
      { price: prices.plans[plan], quantity: 1 },
      ...(terms.includeSetupFee ? [{ price: prices.setup, quantity: 1 }] : []),
    ],
    metadata,
    subscription_data: { metadata: { workspaceId: workspace.id } },
    allow_promotion_codes: true,
    ...tax,
    success_url: appUrl("/billing?done=paid"),
    cancel_url: appUrl("/billing?error=canceled"),
  });
  if (!session.url) throw new Error("Stripe didn't return a checkout link.");
  return session.url;
}

/** Stripe's own page for changing card, plan, invoices or canceling. */
export async function createPortal(workspace: Workspace): Promise<string> {
  if (!workspace.stripeCustomerId) throw new CheckoutNotAllowedError();
  const portal = await stripe().billingPortal.sessions.create({
    customer: workspace.stripeCustomerId,
    return_url: appUrl("/billing"),
  });
  return portal.url;
}

/** Used when an owner deletes their account: stop billing straight away. Already gone is fine. */
export async function cancelSubscriptionNow(subscriptionId: string) {
  try {
    await stripe().subscriptions.cancel(subscriptionId);
  } catch (err) {
    if ((err as { code?: string }).code === "resource_missing") return;
    throw err;
  }
}

async function log(workspaceId: string, action: string, detail: Record<string, unknown>) {
  await db().insert(activityLog).values({ workspaceId, actor: "squared_away", action, detail });
}

async function workspaceById(id: string | null | undefined) {
  if (!id) return undefined;
  const [w] = await db().select().from(workspaces).where(eq(workspaces.id, id));
  return w;
}

export async function applyCheckoutCompleted(session: Stripe.Checkout.Session, now = new Date()) {
  if (session.mode !== "subscription" || session.payment_status !== "paid") return "ignored";
  const w = await workspaceById(session.metadata?.workspaceId ?? session.client_reference_id);
  if (!w) return "unknown_workspace";
  const plan = isPlanId(session.metadata?.plan) ? session.metadata.plan : w.plan;
  const includesSetup = session.metadata?.includesSetup === "1";
  const to = statusAfterCheckout(w, now);
  await db()
    .update(workspaces)
    .set({
      status: to,
      plan,
      stripeCustomerId:
        typeof session.customer === "string" ? session.customer : w.stripeCustomerId,
      stripeSubscriptionId:
        typeof session.subscription === "string" ? session.subscription : w.stripeSubscriptionId,
      // The only place a real setup payment is recorded — and what turns sending on.
      ...(includesSetup
        ? { setupPaidAt: w.setupPaidAt ?? now, setupPaidVia: "stripe" as const }
        : {}),
    })
    .where(eq(workspaces.id, w.id));
  await log(w.id, "payment_received", { plan, includesSetup, from: w.status, to });
  // Plan #47: a referral is settled the first time the account is active. Never fails the webhook.
  if (to === "active") await creditReferralSafely(w.id, now);
  return "applied";
}

export async function applySubscription(sub: Stripe.Subscription, now = new Date()) {
  let w = await workspaceById(sub.metadata?.workspaceId);
  if (!w) {
    const [bySub] = await db()
      .select()
      .from(workspaces)
      .where(eq(workspaces.stripeSubscriptionId, sub.id));
    w = bySub;
  }
  if (!w) return "unknown_workspace";
  const to = statusAfterSubscription(w, sub.status, now);
  const plan = planFromLookupKey(sub.items.data[0]?.price?.lookup_key) ?? w.plan;
  const ended = sub.status === "canceled" || sub.status === "incomplete_expired";
  await db()
    .update(workspaces)
    .set({ status: to, plan, stripeSubscriptionId: ended ? null : sub.id })
    .where(eq(workspaces.id, w.id));
  if (to !== w.status || plan !== w.plan) {
    await log(w.id, "subscription_changed", { stripeStatus: sub.status, from: w.status, to, plan });
  }
  if (to === "active") await creditReferralSafely(w.id, now);
  return "applied";
}

/**
 * The webhook: verify Stripe's signature, handle each event once, and let
 * Stripe — never the browser — change what an account can do.
 */
export async function handleStripeWebhook(rawBody: string, signature: string | null) {
  const secret = await webhookSecret();
  if (!secret || !signature) return { status: 400 as const, body: "Not configured." };
  let event: Stripe.Event;
  try {
    event = await stripe().webhooks.constructEventAsync(rawBody, signature, secret);
  } catch {
    return { status: 400 as const, body: "Bad signature." };
  }
  const [fresh] = await db()
    .insert(stripeEvents)
    .values({ id: event.id, type: event.type })
    .onConflictDoNothing()
    .returning({ id: stripeEvents.id });
  if (!fresh) return { status: 200 as const, body: "Already handled." };

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await applyCheckoutCompleted(event.data.object);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await applySubscription(event.data.object);
        break;
    }
  } catch (err) {
    // Let Stripe retry: forget we saw it.
    await db().delete(stripeEvents).where(eq(stripeEvents.id, event.id));
    throw err;
  }
  return { status: 200 as const, body: "ok" };
}
