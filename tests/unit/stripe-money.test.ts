import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { activityLog, appSettings, stripeMoneyEvents, workspaces } from "@/db/schema";
import { encryptSecret } from "@/lib/crypto";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { adminOverview } from "@/server/admin";
import { describeActivity } from "@/server/activity";
import { handleStripeWebhook, setStripeForTests } from "@/server/billing";
import { setupLookupKey } from "@/server/billing-rules";
import { canSend } from "@/server/lifecycle";
import { recordDispute, openDisputeCount } from "@/server/stripe-money";
import { moneyLines, openDisputesLine, refundSentence } from "@/server/stripe-money-rules";
import { createTestDb } from "../support/db";

/** Check 17 P8: refunds and card disputes are recorded and shown; nothing moves on its own. */

const SECRET = "whsec_test";
let database: Database;
let workspaceId: string;
const refunds: Stripe.Refund[] = [];
let invoiceHasSetup = true;

function fake(): Stripe {
  return {
    refunds: { list: async () => ({ data: refunds }) },
    invoicePayments: { list: async () => ({ data: [{ invoice: "in_1" }] }) },
    prices: { list: async () => ({ data: [{ id: "price_setup", lookup_key: setupLookupKey() }] }) },
    invoices: {
      listLineItems: async () => ({
        data: [
          { pricing: { price_details: { price: "price_plan" } } },
          ...(invoiceHasSetup ? [{ pricing: { price_details: { price: "price_setup" } } }] : []),
        ],
      }),
    },
    charges: { retrieve: async () => ({ id: "ch_1", customer: "cus_1" }) },
    webhooks: {
      constructEventAsync: async (body: string, sig: string, secret: string) => {
        if (sig !== "good" || secret !== SECRET) throw new Error("No signatures found");
        return JSON.parse(body);
      },
    },
  } as unknown as Stripe;
}

const charge = {
  id: "ch_1",
  customer: "cus_1",
  payment_intent: "pi_1",
} as unknown as Stripe.Charge;
const dispute = (status = "needs_response") =>
  ({
    id: "dp_1",
    amount: 49_900,
    charge: "ch_1",
    status,
    livemode: false,
    evidence_details: { due_by: Date.UTC(2026, 9, 30, 15) / 1000 },
  }) as unknown as Stripe.Dispute;
const event = (id: string, type: string, object: unknown) =>
  JSON.stringify({ id, type, livemode: false, data: { object } });
const reload = async () =>
  (await database.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0]!;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.STRIPE_WEBHOOK_SECRET;
  database = await createTestDb();
  refunds.length = 0;
  invoiceHasSetup = true;
  setStripeForTests(fake());
  ({
    workspace: { id: workspaceId },
  } = await ensureUserAndWorkspace({ email: "owner@shop.com" }));
  await database
    .update(workspaces)
    .set({
      status: "active",
      plan: "crew",
      businessName: "Ruiz Street Plumbing",
      setupPaidAt: new Date(),
      setupPaidVia: "stripe",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
    })
    .where(eq(workspaces.id, workspaceId));
  await database
    .insert(appSettings)
    .values({ key: "stripe_webhook_secret", value: encryptSecret(SECRET) });
});
afterEach(() => {
  setStripeForTests(undefined);
  vi.unstubAllEnvs();
});

describe("refunds (Check 17 P8)", () => {
  it("each refund makes one row; repeats make none; status and setupPaidVia never change", async () => {
    refunds.push({
      id: "re_1",
      amount: 49_900,
      status: "succeeded",
      created: Date.UTC(2026, 9, 20, 15) / 1000,
    } as Stripe.Refund);
    expect(
      (await handleStripeWebhook(event("evt_r1", "charge.refunded", charge), "good")).status,
    ).toBe(200);
    // Replayed event, and a new event for the same refund: still one row.
    await handleStripeWebhook(event("evt_r1", "charge.refunded", charge), "good");
    await handleStripeWebhook(event("evt_r2", "charge.refunded", charge), "good");
    const rows = await database.select().from(stripeMoneyEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "re_1",
      kind: "refund",
      amountCents: 49_900,
      includesSetup: true,
      workspaceId,
    });
    // GUARDRAIL: Davi decides what a refund means.
    const after = await reload();
    expect(after).toMatchObject({ status: "active", setupPaidVia: "stripe" });
    expect(canSend(after)).toBe(true);
    const logs = (await database.select().from(activityLog)).filter(
      (l) => l.action === "refund_recorded",
    );
    expect(logs).toHaveLength(1);
    expect(describeActivity("refund_recorded", logs[0]!.detail, null)).toBe(
      "Refunded $499 to your card",
    );
  });

  it("includes_setup comes from the invoice lines (a plan-only refund isn't setup)", async () => {
    invoiceHasSetup = false;
    refunds.push({ id: "re_2", amount: 9_900, status: "succeeded", created: 1 } as Stripe.Refund);
    await handleStripeWebhook(event("evt_r3", "charge.refunded", charge), "good");
    const [row] = await database.select().from(stripeMoneyEvents);
    expect(row!.includesSetup).toBe(false);
    expect(refundSentence(9_900)).toBe("Refunded $99 to your card");
  });
});

describe("card disputes (Check 17 P8)", () => {
  it("opened and closed each make one row; Davi is emailed once per dispute", async () => {
    vi.stubEnv("ADMIN_EMAIL", "davi@example.com");
    const sent: Array<{ subject: string; text: string; idempotencyKey: string }> = [];
    const send = async (e: { subject: string; text: string; idempotencyKey: string }) => {
      sent.push(e);
      return "sent" as const;
    };
    const now = new Date("2026-10-21T12:00:00Z");
    expect(await recordDispute(dispute(), "dispute_opened", now, { send })).toBe(true);
    expect(await recordDispute(dispute(), "dispute_opened", now, { send })).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.idempotencyKey).toBe("dispute-dp_1");
    expect(sent[0]!.text).toContain("Ruiz Street Plumbing");
    expect(sent[0]!.text).toContain("$499");
    expect(sent[0]!.text).toContain("Oct 30");
    expect(sent[0]!.text).toContain("https://dashboard.stripe.com/test/disputes/dp_1");
    expect(await openDisputeCount()).toBe(1);
    expect(openDisputesLine(1)).toMatch(/^1 card dispute is open/);

    let [row] = await adminOverview(now);
    expect(moneyLines(row!.moneyEvents)).toEqual([
      { text: "Card dispute open: answer by Oct 30", strong: true },
    ]);

    await recordDispute(dispute("lost"), "dispute_closed", now, { send });
    expect(sent).toHaveLength(1);
    expect(await openDisputeCount()).toBe(0);
    [row] = await adminOverview(now);
    expect(moneyLines(row!.moneyEvents)).toEqual([
      { text: "Card dispute closed: lost ($499)", strong: false },
    ]);
    // No owner sentence for a dispute, and nothing about the account changed.
    expect((await database.select().from(activityLog)).map((l) => l.action)).not.toContain(
      "dispute_opened",
    );
    expect((await reload()).status).toBe("active");
  });

  it("the admin card shows a refund line with (setup) and the date", () => {
    expect(
      moneyLines([
        {
          id: "re_1",
          kind: "refund",
          amountCents: 49_900,
          includesSetup: true,
          evidenceDueBy: null,
          outcome: null,
          createdAt: new Date("2026-10-20T15:00:00Z"),
        },
      ]),
    ).toEqual([{ text: "Refunded $499 (setup) on Oct 20", strong: false }]);
    expect(openDisputesLine(0)).toBeNull();
  });
});
