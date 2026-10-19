import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { activityLog, appSettings, workspaces, type Workspace } from "@/db/schema";
import { deleteAccount } from "@/server/account-deletion";
import { ensureUserAndWorkspace } from "@/server/accounts";
import {
  applyCheckoutCompleted,
  applySubscription,
  createCheckout,
  setStripeForTests,
  stripeOrphans,
  workspacesWithTwoPlans,
} from "@/server/billing";
import { planLookupKey } from "@/server/billing-rules";
import type { MailboxConnector } from "@/mailbox/connector";
import { createTestDb } from "../support/db";

/**
 * Check 17 P4: Stripe doesn't promise the order of webhook events. Each subscription event is
 * read fresh from Stripe, and an event about a subscription other than the account's own never
 * changes the account.
 */

const NOW = new Date("2026-10-10T14:00:00Z");
type Call = { method: string; args: unknown[] };

let database: Database;
let workspace: Workspace;
let calls: Call[];
const subs = new Map<string, Stripe.Subscription>();
let sessionNo = 0;

const missing = () =>
  Object.assign(new Error("No such subscription"), { code: "resource_missing" });

function fake(): Stripe {
  const rec =
    (method: string, fn: (...a: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return fn(...args);
    };
  return {
    tax: { settings: { retrieve: rec("tax", () => ({ status: "pending" })) } },
    prices: {
      list: rec("prices.list", () => ({ data: [] })),
      create: rec("prices.create", (p) => ({
        id: `price_${(p as { lookup_key: string }).lookup_key}`,
      })),
    },
    customers: { create: rec("customers.create", () => ({ id: "cus_1" })) },
    subscriptions: {
      retrieve: rec("subscriptions.retrieve", (id) => {
        const sub = subs.get(id as string);
        if (!sub) throw missing();
        return sub;
      }),
      list: rec("subscriptions.list", (p) => ({
        data: [...subs.values()].filter((s) => s.customer === (p as { customer: string }).customer),
      })),
      cancel: rec("subscriptions.cancel", (id) => {
        const sub = subs.get(id as string);
        if (!sub) throw missing();
        subs.set(id as string, { ...sub, status: "canceled" });
        return { id };
      }),
    },
    checkout: {
      sessions: {
        create: rec("checkout.sessions.create", () => ({
          id: `cs_${++sessionNo}`,
          url: "https://checkout.example/cs",
        })),
        expire: rec("checkout.sessions.expire", (id) => {
          if (id === "cs_done") throw Object.assign(new Error("complete"), { type: "x" });
          return { id };
        }),
      },
    },
  } as unknown as Stripe;
}

/** What Stripe holds now for a subscription (and the payload an event about it carries). */
function sub(id: string, status: string, plan: "solo" | "crew" | "company" = "crew") {
  const s = {
    id,
    status,
    customer: "cus_1",
    metadata: { workspaceId: workspace.id },
    items: { data: [{ price: { lookup_key: planLookupKey(plan) } }] },
  } as unknown as Stripe.Subscription;
  subs.set(id, s);
  return s;
}

const session = (id: string, subscription: string, plan = "crew") =>
  ({
    id,
    mode: "subscription",
    payment_status: "paid",
    customer: "cus_1",
    subscription,
    client_reference_id: workspace.id,
    metadata: { workspaceId: workspace.id, plan, includesSetup: "1" },
  }) as unknown as Stripe.Checkout.Session;

async function reload() {
  const [row] = await database.select().from(workspaces).where(eq(workspaces.id, workspace.id));
  return row!;
}

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.APP_URL = "https://app.example";
  database = await createTestDb();
  calls = [];
  subs.clear();
  sessionNo = 0;
  setStripeForTests(fake());
  ({ workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com", name: "Owner" }));
  await database
    .update(workspaces)
    .set({ status: "evaluating", evaluationEndsAt: new Date(NOW.getTime() + 86_400_000) })
    .where(eq(workspaces.id, workspace.id));
});
afterEach(() => {
  setStripeForTests(undefined);
  vi.restoreAllMocks();
});

describe("late, stale and duplicate subscriptions (Check 17 P4)", () => {
  it("a late deleted event for an old subscription leaves the new one alone", async () => {
    // Owner had sub_old, it was canceled, then they bought again (sub_new).
    await applyCheckoutCompleted(session("cs_new", "sub_new"), NOW);
    sub("sub_new", "active");
    const old = sub("sub_old", "canceled");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await applySubscription(old, NOW)).toBe("stale");
    const after = await reload();
    expect(after.status).toBe("setup_paid");
    expect(after.stripeSubscriptionId).toBe("sub_new");
    expect(info).toHaveBeenCalledWith("stripe_event_stale");
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/sub_|cus_/);
  });

  it("past_due, then a stale 'active' payload: still past_due, because Stripe says so now", async () => {
    await applyCheckoutCompleted(session("cs_1", "sub_1"), NOW);
    const stalePayload = sub("sub_1", "active");
    await applySubscription(sub("sub_1", "past_due"), NOW);
    expect((await reload()).status).toBe("past_due");
    // The older "active" event arrives late; Stripe's current state is past_due.
    await applySubscription(stalePayload, NOW);
    expect((await reload()).status).toBe("past_due");
  });

  it("a subscription Stripe no longer has counts as canceled", async () => {
    await applyCheckoutCompleted(session("cs_1", "sub_1"), NOW);
    const payload = sub("sub_1", "active");
    subs.delete("sub_1");
    await applySubscription(payload, NOW);
    expect(await reload()).toMatchObject({ status: "canceled", stripeSubscriptionId: null });
  });

  it("a second paid checkout flags both and doesn't overwrite the first", async () => {
    sub("sub_1", "active");
    await applyCheckoutCompleted(session("cs_1", "sub_1"), NOW);
    sub("sub_2", "active", "company");
    await applyCheckoutCompleted(session("cs_2", "sub_2", "company"), NOW);
    const after = await reload();
    expect(after.stripeSubscriptionId).toBe("sub_1");
    expect(after.plan).toBe("crew");
    expect(await workspacesWithTwoPlans([workspace.id])).toEqual(new Set([workspace.id]));
    const rows = await database.select().from(activityLog);
    expect(rows.filter((r) => r.action === "second_subscription")).toHaveLength(1);
    expect(rows.find((r) => r.action === "second_subscription")!.detail).toEqual({});

    // An update for the second one changes nothing on the account either.
    expect(await applySubscription(sub("sub_2", "past_due", "company"), NOW)).toBe(
      "second_subscription",
    );
    expect((await reload()).status).toBe("setup_paid");

    // Canceling the second one in Stripe clears the flag.
    await applySubscription(sub("sub_2", "canceled", "company"), NOW);
    expect(await workspacesWithTwoPlans([workspace.id])).toEqual(new Set());
    expect((await reload()).stripeSubscriptionId).toBe("sub_1");
  });

  it("when the first plan ends while a second is live, the second carries on", async () => {
    sub("sub_1", "active");
    await applyCheckoutCompleted(session("cs_1", "sub_1"), NOW);
    sub("sub_2", "active", "company");
    await applyCheckoutCompleted(session("cs_2", "sub_2", "company"), NOW);
    await applySubscription(sub("sub_1", "canceled"), NOW);
    const after = await reload();
    expect(after.stripeSubscriptionId).toBe("sub_2");
    expect(after.plan).toBe("company");
    expect(after.status).toBe("setup_paid");
    expect(await workspacesWithTwoPlans([workspace.id])).toEqual(new Set());
  });

  it("a new checkout expires the previous open one; one Stripe customer per workspace", async () => {
    await createCheckout(await reload(), "crew");
    await createCheckout(await reload(), "solo");
    expect(
      calls.filter((c) => c.method === "checkout.sessions.expire").map((c) => c.args[0]),
    ).toEqual(["cs_1"]);
    const customer = calls.filter((c) => c.method === "customers.create");
    expect(customer).toHaveLength(1);
    expect(customer[0]!.args[1]).toEqual({ idempotencyKey: `customer-${workspace.id}` });
    // Paying the open one forgets it: the next checkout has nothing to expire.
    await applyCheckoutCompleted(session("cs_2", "sub_1"), NOW);
    const key = `stripe-ws:open-checkout:${workspace.id}`;
    expect(await database.select().from(appSettings).where(eq(appSettings.key, key))).toHaveLength(
      0,
    );
  });

  it("expiring an already-complete session is ignored", async () => {
    await database
      .insert(appSettings)
      .values({ key: `stripe-ws:open-checkout:${workspace.id}`, value: "cs_done" });
    vi.spyOn(console, "info").mockImplementation(() => {});
    await expect(createCheckout(await reload(), "crew")).resolves.toBeTruthy();
  });

  it("a customer stored by a faster tap is kept, never overwritten", async () => {
    const stale = await reload();
    await database
      .update(workspaces)
      .set({ stripeCustomerId: "cus_first" })
      .where(eq(workspaces.id, workspace.id));
    await createCheckout(stale, "crew");
    expect((await reload()).stripeCustomerId).toBe("cus_first");
    const create = calls.find((c) => c.method === "checkout.sessions.create")!;
    expect((create.args[0] as { customer: string }).customer).toBe("cus_first");
  });

  it("a live plan or paid checkout with no account here is counted for /admin", async () => {
    const orphan = {
      ...sub("sub_x", "active"),
      metadata: { workspaceId: "00000000-0000-4000-8000-000000000000" },
    } as Stripe.Subscription;
    subs.set("sub_x", orphan);
    expect(await applySubscription(orphan, NOW)).toBe("unknown_workspace");
    expect(
      await applyCheckoutCompleted(
        {
          ...session("cs_x", "sub_x"),
          client_reference_id: null,
          metadata: { workspaceId: "00000000-0000-4000-8000-000000000000" },
        } as unknown as Stripe.Checkout.Session,
        NOW,
      ),
    ).toBe("unknown_workspace");
    expect((await stripeOrphans())?.count).toBe(2);
    // An ended one isn't worth a look.
    subs.set("sub_x", { ...orphan, status: "canceled" });
    await applySubscription(orphan, NOW);
    expect((await stripeOrphans())?.count).toBe(2);
  });

  it("Delete my account cancels every live subscription of the customer", async () => {
    await applyCheckoutCompleted(session("cs_1", "sub_1"), NOW);
    sub("sub_1", "active");
    sub("sub_2", "active");
    sub("sub_ended", "canceled");
    const connector = { revoke: async () => {} } as unknown as MailboxConnector;
    const [owner] = await database
      .select({ id: workspaces.ownerUserId })
      .from(workspaces)
      .where(eq(workspaces.id, workspace.id));
    const r = await deleteAccount(owner!.id, connector);
    expect(r.subscriptionCanceled).toBe(true);
    const canceled = calls.filter((c) => c.method === "subscriptions.cancel").map((c) => c.args[0]);
    expect(canceled.sort()).toEqual(["sub_1", "sub_2"]);
  });

  it("if any cancel fails, nothing is deleted", async () => {
    await applyCheckoutCompleted(session("cs_1", "sub_1"), NOW);
    sub("sub_1", "active");
    const gone = sub("sub_2", "active");
    subs.delete("sub_2");
    // sub_2 is listed but the cancel throws something other than "already gone".
    const f = fake() as unknown as {
      subscriptions: { list: unknown; cancel: (id: string) => Promise<unknown> };
    };
    f.subscriptions.list = async () => ({ data: [subs.get("sub_1"), gone] });
    f.subscriptions.cancel = async (id: string) => {
      if (id === "sub_2") throw Object.assign(new Error("down"), { code: "api_error" });
      return { id };
    };
    setStripeForTests(f as unknown as Stripe);
    const [owner] = await database
      .select({ id: workspaces.ownerUserId })
      .from(workspaces)
      .where(eq(workspaces.id, workspace.id));
    await expect(
      deleteAccount(owner!.id, { revoke: async () => {} } as unknown as MailboxConnector),
    ).rejects.toThrow(/nothing was deleted/);
    expect(await reload()).toBeTruthy();
  });
});

describe("every order of the three checkout events ends the same (Check 17 P4)", () => {
  const EVENTS = ["checkout", "created", "updated"] as const;
  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ].map((o) => o.map((i) => EVENTS[i]!));

  it("checkout.session.completed / subscription.created / subscription.updated", async () => {
    const finals: string[] = [];
    for (const order of orders) {
      await database
        .update(workspaces)
        .set({
          status: "evaluating",
          plan: null,
          setupPaidAt: null,
          setupPaidVia: null,
          stripeCustomerId: null,
          stripeSubscriptionId: null,
        })
        .where(eq(workspaces.id, workspace.id));
      subs.clear();
      const created = sub("sub_1", "incomplete");
      const updated = sub("sub_1", "active");
      // Stripe holds the latest: active.
      for (const step of order) {
        if (step === "checkout") await applyCheckoutCompleted(session("cs_1", "sub_1"), NOW);
        else await applySubscription(step === "created" ? created : updated, NOW);
      }
      const w = await reload();
      finals.push(
        JSON.stringify({
          status: w.status,
          plan: w.plan,
          sub: w.stripeSubscriptionId,
          customer: w.stripeCustomerId,
          via: w.setupPaidVia,
        }),
      );
    }
    expect(new Set(finals).size).toBe(1);
    expect(JSON.parse(finals[0]!)).toEqual({
      status: "setup_paid",
      plan: "crew",
      sub: "sub_1",
      customer: "cus_1",
      via: "stripe",
    });
  });
});
