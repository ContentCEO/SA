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
import { brandEmail } from "@/lib/email-layout";
import { sendEmail, type EmailSender } from "@/lib/email";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import {
  checkoutTerms,
  eventFromOtherMode,
  isPlanId,
  PLAN_IDS,
  planFromLookupKey,
  planEndsAtFrom,
  planLookupKey,
  localDateKey,
  type SalesTaxStatus,
  setupLookupKey,
  statusAfterCheckout,
  statusAfterSubscription,
  stripeKeyMode,
} from "./billing-rules";
import { paymentNoticeCopy } from "./first-week-rules";
import { resumeTarget, setupReallyPaid } from "./lifecycle";
import { fitMailboxesToPlan } from "./mailbox-plan";
import { creditReferralSafely } from "./referrals";
import { workspaceTimeZone } from "./snooze";
import { isTermsUrlMissingError, stripeErrorReason } from "./stripe-error-rules";

let client: Stripe | undefined;
let override: Stripe | undefined;

/** Tests swap in a fake. */
export function setStripeForTests(fake: Stripe | undefined) {
  override = fake;
}

export function stripeConfigured() {
  return Boolean(override || process.env.STRIPE_SECRET_KEY);
}

/**
 * Live or test mode, from the secret key (`sk_live_` / `rk_live_` = live); null without a key.
 * Read from the key even when a test fake is swapped in, so tests set the key to pick a mode.
 */
export function stripeMode(): "live" | "test" | null {
  return stripeKeyMode(process.env.STRIPE_SECRET_KEY);
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
    mode: stripeMode() === "live" ? "live" : "test",
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
  const params: Stripe.Checkout.SessionCreateParams = {
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
  };
  let session: Stripe.Checkout.Session;
  let withBox = true;
  try {
    session = await s.checkout.sessions.create({ ...params, ...termsAgreementParams() });
  } catch (err) {
    // Stripe refuses the box until a terms link is saved in its dashboard. Owners already
    // agreed at sign-in, so the payment goes ahead without it and /admin says what to fix.
    // Any other error goes up exactly as before.
    if (!isTermsUrlMissingError(err)) throw err;
    console.warn("stripe_terms_url_missing", { workspaceId: workspace.id });
    withBox = false;
    session = await s.checkout.sessions.create(params);
  }
  // The /admin note is a reminder only: writing it never stops a payment.
  await noteTermsBox(withBox);
  if (!session.url) throw new Error("Stripe didn't return a checkout link.");
  return session.url;
}

/**
 * The "I agree" box on Stripe's checkout page (Davi, 2026-10-15): the owner must tick it before
 * paying, next to our own words with links to our terms and privacy policy. Stripe also needs the
 * Terms of Service URL saved in its dashboard (Settings → Business → Public details).
 */
function termsAgreementParams(): Pick<
  Stripe.Checkout.SessionCreateParams,
  "consent_collection" | "custom_text"
> {
  return {
    consent_collection: { terms_of_service: "required" },
    custom_text: {
      terms_of_service_acceptance: {
        message: `I agree to the [Terms of Service](${appUrl("/terms")}) and the [Privacy Policy](${appUrl("/privacy")}).`,
      },
    },
  };
}

/** app_settings key: when a checkout last had to go without the terms box (its time, ISO). */
const TERMS_BOX_OFF_KEY = "stripe_terms_box_off";

/** Box on: forget any earlier "off". Box off: remember when. Never throws. */
async function noteTermsBox(withBox: boolean, now: Date = new Date()) {
  try {
    if (withBox) {
      await db().delete(appSettings).where(eq(appSettings.key, TERMS_BOX_OFF_KEY));
      return;
    }
    const value = now.toISOString();
    await db()
      .insert(appSettings)
      .values({ key: TERMS_BOX_OFF_KEY, value, updatedAt: now })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } });
  } catch (err) {
    console.error("stripe_terms_box_note_failed", {
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}

/**
 * For the /admin Payments card: when the last checkout had to go without the terms box, or null
 * (never, or a later checkout had it). Database only: loading the page asks Stripe nothing.
 */
export async function termsBoxOffSince(): Promise<Date | null> {
  const [row] = await db()
    .select({ updatedAt: appSettings.updatedAt })
    .from(appSettings)
    .where(eq(appSettings.key, TERMS_BOX_OFF_KEY));
  return row?.updatedAt ?? null;
}

/**
 * Stripe's own page for changing card, plan, invoices or canceling. It comes back to Plan &
 * billing, or to the terms screen when it was opened from there (someone who won't agree to new
 * terms can still cancel).
 */
export async function createPortal(
  workspace: Workspace,
  returnTo: "/billing" | "/welcome/terms" = "/billing",
): Promise<string> {
  if (!workspace.stripeCustomerId) throw new CheckoutNotAllowedError();
  const portal = await stripe().billingPortal.sessions.create({
    customer: workspace.stripeCustomerId,
    return_url: appUrl(returnTo),
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

/**
 * Round 2 (FW K7): tell Davi a payment came in, so the setup call doesn't wait on him noticing.
 * Content-free (the plan's name and whether setup was in it; who it is stays on /admin). Once
 * per checkout (`app_settings` marker, Resend idempotency key). Never throws: a failed email
 * never fails the webhook. Logs the error's name only.
 */
export async function notifyPaymentReceived(
  sessionId: string,
  o: { plan: PlanId | null; includesSetup: boolean },
  deps: { send?: EmailSender } = {},
): Promise<"sent" | "skipped" | "failed"> {
  const admin = process.env.ADMIN_EMAIL;
  if (!admin) return "skipped";
  const key = `payment-notice:${sessionId}`;
  try {
    const [seen] = await db().select().from(appSettings).where(eq(appSettings.key, key));
    if (seen) return "skipped";
    const c = paymentNoticeCopy({
      planName: o.plan ? pricing.plans[o.plan].name : null,
      includesSetup: o.includesSetup,
      adminUrl: appUrl("/admin"),
    });
    const { text, html } = brandEmail({
      serif: c.serif,
      heavy: c.heavy,
      lines: c.lines,
      button: c.button,
      footer: c.footer,
    });
    const outcome = await (deps.send ?? sendEmail)({
      to: admin,
      subject: c.subject,
      text,
      html,
      idempotencyKey: `payment-${sessionId}`,
    });
    if (outcome === "not_configured") return "skipped";
    await db()
      .insert(appSettings)
      .values({ key, value: new Date().toISOString() })
      .onConflictDoNothing();
    return "sent";
  } catch (err) {
    console.error("payment_notice_failed", { error: err instanceof Error ? err.name : "unknown" });
    return "failed";
  }
}

/**
 * The plan's Gmail limit after a payment or plan change (2026-10-16). Never fails the webhook:
 * the 15-minute job fits it again if this didn't (`fitAllMailboxesToPlans`). Ids and names only.
 */
async function fitMailboxesSafely(workspaceId: string, now: Date) {
  try {
    await fitMailboxesToPlan(workspaceId, now);
  } catch (err) {
    console.error("mailbox_plan_fit_failed", {
      workspaceId,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}

export async function applyCheckoutCompleted(
  session: Stripe.Checkout.Session,
  now = new Date(),
  deps: { send?: EmailSender } = {},
) {
  if (session.mode !== "subscription" || session.payment_status !== "paid") return "ignored";
  const w = await workspaceById(session.metadata?.workspaceId ?? session.client_reference_id);
  if (!w) return "unknown_workspace";
  const plan = isPlanId(session.metadata?.plan) ? session.metadata.plan : w.plan;
  const includesSetup = session.metadata?.includesSetup === "1";
  // Check 17 P1: a paused account isn't moved by Stripe; the payment is kept in paused_from,
  // where Resume takes it back to.
  const paused = w.status === "paused";
  const settled = statusAfterCheckout(
    paused ? { ...w, status: w.pausedFrom ?? resumeTarget(w, now) } : w,
    now,
  );
  const to = paused ? w.status : settled;
  await db()
    .update(workspaces)
    .set({
      status: to,
      ...(paused ? { pausedFrom: settled } : {}),
      plan,
      stripeCustomerId:
        typeof session.customer === "string" ? session.customer : w.stripeCustomerId,
      stripeSubscriptionId:
        typeof session.subscription === "string" ? session.subscription : w.stripeSubscriptionId,
      // The only place a real setup payment is recorded — and what turns sending on. The date is
      // this payment's unless one was already really paid (a hand-marked or test-card date isn't).
      ...(includesSetup
        ? {
            setupPaidAt: setupReallyPaid(w) ? (w.setupPaidAt ?? now) : now,
            setupPaidVia: "stripe" as const,
          }
        : {}),
    })
    .where(eq(workspaces.id, w.id));
  await log(w.id, "payment_received", { plan, includesSetup, from: w.status, to });
  await fitMailboxesSafely(w.id, now);
  await notifyPaymentReceived(session.id, { plan, includesSetup }, deps);
  // Plan #47: a referral is settled the first time the account is active. Never fails the webhook.
  if (to === "active") await creditReferralSafely(w.id, now);
  return "applied";
}

/** Check 17 P3: one activity row when a plan end date is newly scheduled (the date only). */
async function notePlanEnd(w: Workspace, planEndsAt: Date | null) {
  if (!planEndsAt || planEndsAt.getTime() === w.planEndsAt?.getTime()) return;
  const endsOn = localDateKey(planEndsAt, await workspaceTimeZone(w.id));
  await log(w.id, "plan_cancel_scheduled", { endsOn });
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
  const plan = planFromLookupKey(sub.items.data[0]?.price?.lookup_key) ?? w.plan;
  const ended = sub.status === "canceled" || sub.status === "incomplete_expired";
  // Check 17 P3: a cancellation from Stripe's page keeps the plan on until a date; say when.
  const planEndsAt = planEndsAtFrom(sub);
  await notePlanEnd(w, planEndsAt);
  if (w.status === "paused") {
    // Check 17 P1: a paused account stays paused, but what Stripe says is kept in paused_from,
    // so Resume takes it to where the payment stands now (never back to "active" after a
    // canceled or failed subscription).
    const before = w.pausedFrom ?? resumeTarget(w, now);
    const after = statusAfterSubscription({ ...w, status: before }, sub.status, now);
    await db()
      .update(workspaces)
      .set({ pausedFrom: after, plan, planEndsAt, stripeSubscriptionId: ended ? null : sub.id })
      .where(eq(workspaces.id, w.id));
    if (after !== w.pausedFrom || plan !== w.plan) {
      await log(w.id, "subscription_changed", {
        stripeStatus: sub.status,
        from: w.status,
        to: w.status,
        pausedFrom: { before: w.pausedFrom, after },
        plan,
      });
    }
    if (plan !== w.plan) await fitMailboxesSafely(w.id, now);
    return "applied";
  }
  const to = statusAfterSubscription(w, sub.status, now);
  await db()
    .update(workspaces)
    .set({ status: to, plan, planEndsAt, stripeSubscriptionId: ended ? null : sub.id })
    .where(eq(workspaces.id, w.id));
  if (to !== w.status || plan !== w.plan) {
    await log(w.id, "subscription_changed", { stripeStatus: sub.status, from: w.status, to, plan });
  }
  // A cheaper plan pauses the Gmail addresses it doesn't cover; a bigger one turns them back on.
  if (plan !== w.plan) await fitMailboxesSafely(w.id, now);
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
  // Only events from the mode the key talks to. Until Connect Stripe runs again after the switch
  // to live (LAUNCH.md 7b), the stored secret is still the test endpoint's: its renewals and late
  // test checkouts would otherwise put test ids (and a "paid" setup) back on accounts "Reset test
  // payments" cleared. Answered 200, so Stripe stops sending it.
  if (eventFromOtherMode(event.livemode, stripeMode())) {
    console.info("stripe_event_other_mode", { livemode: event.livemode === true });
    return { status: 200 as const, body: "Ignored: other Stripe mode." };
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
