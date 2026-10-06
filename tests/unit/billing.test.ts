import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pricing } from "@/config/pricing";
import type { Database } from "@/db";
import { activityLog, appSettings, stripeEvents, workspaces, type Workspace } from "@/db/schema";
import { encryptSecret } from "@/lib/crypto";
import { ensureUserAndWorkspace } from "@/server/accounts";
import {
  applyCheckoutCompleted,
  applySubscription,
  CheckoutNotAllowedError,
  createCheckout,
  handleStripeWebhook,
  setStripeForTests,
} from "@/server/billing";
import {
  checkoutTerms,
  planFromLookupKey,
  planLookupKey,
  setupLookupKey,
  statusAfterCheckout,
  statusAfterSubscription,
} from "@/server/billing-rules";
import { canSend, jobsAllowed } from "@/server/lifecycle";
import { createTestDb } from "../support/db";

const NOW = new Date("2026-10-10T14:00:00Z");
type S = Workspace["status"];
const w = (status: S, over: Partial<Workspace> = {}) => ({
  status,
  evaluationEndsAt: null,
  setupPaidAt: null,
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
    expect(checkoutTerms(w("canceled", { setupPaidAt: NOW }), NOW)).toEqual({
      allowed: true,
      includeSetupFee: false,
    });
    expect(checkoutTerms(w("active", { stripeSubscriptionId: "sub_1" }), NOW).allowed).toBe(false);
    expect(checkoutTerms(w("paused"), NOW).allowed).toBe(false);
  });

  it("paying turns sending on, and keeps a finished setup active", () => {
    for (const s of ["invited", "evaluating", "evaluation_expired", "canceled"] as S[]) {
      expect(statusAfterCheckout(w(s), NOW)).toBe("setup_paid");
    }
    expect(statusAfterCheckout(w("canceled", { setupCallCompletedAt: NOW }), NOW)).toBe("active");
    expect(statusAfterCheckout(w("active"), NOW)).toBe("active");
    expect(canSend(w(statusAfterCheckout(w("evaluating"), NOW)), NOW)).toBe(true);
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
type Call = { method: string; args: unknown[] };

function fakeStripe(calls: Call[]) {
  const rec =
    (method: string, result: (...a: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return result(...args);
    };
  let n = 0;
  return {
    prices: {
      list: rec("prices.list", () => ({ data: [] })),
      create: rec("prices.create", (p) => ({
        id: `price_${(p as { lookup_key: string }).lookup_key}`,
      })),
    },
    customers: { create: rec("customers.create", () => ({ id: "cus_1" })) },
    checkout: {
      sessions: {
        create: rec("checkout.sessions.create", () => ({
          id: `cs_${++n}`,
          url: "https://checkout.example/cs",
        })),
      },
    },
    webhooks: {
      constructEventAsync: async (body: string, sig: string, secret: string) => {
        if (sig !== "good" || secret !== SECRET) throw new Error("No signatures found");
        return JSON.parse(body);
      },
    },
  } as unknown as Stripe;
}

let database: Database;
let calls: Call[];
let workspace: Workspace;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.APP_URL = "https://app.example";
  delete process.env.STRIPE_WEBHOOK_SECRET;
  database = await createTestDb();
  calls = [];
  setStripeForTests(fakeStripe(calls));
  ({ workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com", name: "Owner" }));
  await database
    .update(workspaces)
    .set({ status: "evaluating", evaluationEndsAt: new Date(Date.now() + 86_400_000) })
    .where(eq(workspaces.id, workspace.id));
  await database
    .insert(appSettings)
    .values({ key: "stripe_webhook_secret", value: encryptSecret(SECRET) });
});
afterEach(() => setStripeForTests(undefined));

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
      .set({ status: "canceled", setupPaidAt: NOW, stripeCustomerId: "cus_old" })
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

describe("webhook-driven status", () => {
  it("a paid checkout turns sending on and records the plan and setup fee", async () => {
    expect(await applyCheckoutCompleted(paidSession(), NOW)).toBe("applied");
    const after = await reload();
    expect(after.status).toBe("setup_paid");
    expect(after.plan).toBe("crew");
    expect(after.stripeSubscriptionId).toBe("sub_1");
    expect(after.setupPaidAt?.toISOString()).toBe(NOW.toISOString());
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

  it("STRIPE_WEBHOOK_SECRET overrides the stored secret", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_other";
    const r = await handleStripeWebhook(event("evt_3", "x.y", {}), "good");
    expect(r.status).toBe(400);
  });
});
