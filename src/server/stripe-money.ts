import "server-only";
import { desc, eq, inArray } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "@/db";
import { activityLog, stripeMoneyEvents, workspaces } from "@/db/schema";
import { brandEmail } from "@/lib/email-layout";
import { sendEmail, type EmailSender } from "@/lib/email";
import { stripeClient } from "./billing";
import { setupLookupKey } from "./billing-rules";
import { disputeNoticeCopy, type MoneyEventRow } from "./stripe-money-rules";

/**
 * Check 17 P8: refunds and card disputes made in Stripe. Recorded and shown on /admin; nothing
 * here changes an account's status or setupPaidVia (Davi decides what a refund means). No card
 * details, no email text: ids, amounts and dates only. Every insert is idempotent on (id, kind).
 */

const customerId = (c: string | { id: string } | null | undefined) =>
  typeof c === "string" ? c : (c?.id ?? null);

async function workspaceForCustomer(customer: string | null) {
  if (!customer) return null;
  const [w] = await db()
    .select({ id: workspaces.id, businessName: workspaces.businessName })
    .from(workspaces)
    .where(eq(workspaces.stripeCustomerId, customer));
  return w ?? null;
}

/**
 * Whether the charge paid an invoice that had the setup fee on it (its price's lookup key).
 * Best effort: anything Stripe can't answer counts as "no", logged by name only.
 */
async function chargeIncludesSetup(charge: Stripe.Charge): Promise<boolean> {
  const pi = customerId(charge.payment_intent as string | { id: string } | null);
  if (!pi) return false;
  try {
    const s = stripeClient();
    const payments = await s.invoicePayments.list({
      payment: { type: "payment_intent", payment_intent: pi },
      limit: 10,
    });
    const setupPrices = await s.prices.list({ lookup_keys: [setupLookupKey()], limit: 10 });
    const setupIds = new Set(setupPrices.data.map((p) => p.id));
    for (const p of payments.data) {
      const invoice = customerId(p.invoice as string | { id: string });
      if (!invoice) continue;
      const lines = await s.invoices.listLineItems(invoice, { limit: 100 });
      for (const line of lines.data) {
        const price = line.pricing?.price_details?.price;
        const id = typeof price === "string" ? price : price?.id;
        const key = typeof price === "object" ? price?.lookup_key : null;
        if ((id && setupIds.has(id)) || key === setupLookupKey()) return true;
      }
    }
  } catch (err) {
    console.error("stripe_setup_check_failed", {
      error: err instanceof Error ? err.name : "unknown",
    });
  }
  return false;
}

/** charge.refunded: one row per refund (Stripe no longer lists them on the charge). */
export async function recordRefunds(charge: Stripe.Charge, now: Date = new Date()) {
  const w = await workspaceForCustomer(customerId(charge.customer));
  const list = await stripeClient().refunds.list({ charge: charge.id, limit: 100 });
  const refunds = list.data.filter((r) => r.status !== "failed" && r.status !== "canceled");
  if (!refunds.length) return 0;
  const includesSetup = await chargeIncludesSetup(charge);
  let added = 0;
  for (const r of refunds) {
    const [row] = await db()
      .insert(stripeMoneyEvents)
      .values({
        id: r.id,
        workspaceId: w?.id ?? null,
        kind: "refund",
        amountCents: r.amount,
        includesSetup,
        createdAt: r.created ? new Date(r.created * 1000) : now,
      })
      .onConflictDoNothing()
      .returning({ id: stripeMoneyEvents.id });
    if (!row) continue;
    added++;
    if (w) {
      await db()
        .insert(activityLog)
        .values({
          workspaceId: w.id,
          actor: "squared_away",
          action: "refund_recorded",
          detail: { amountCents: r.amount },
        });
    }
  }
  return added;
}

const disputeOutcome = (status: string): "won" | "lost" | null =>
  status === "won" ? "won" : status === "lost" ? "lost" : null;

/** charge.dispute.created / charge.dispute.closed. Davi is emailed once per new dispute. */
export async function recordDispute(
  dispute: Stripe.Dispute,
  kind: "dispute_opened" | "dispute_closed",
  now: Date = new Date(),
  deps: { send?: EmailSender; livemode?: boolean } = {},
) {
  const chargeId = customerId(dispute.charge as string | { id: string });
  let customer: string | null = null;
  if (chargeId) {
    const charge =
      typeof dispute.charge === "object"
        ? dispute.charge
        : await stripeClient().charges.retrieve(chargeId);
    customer = customerId(charge.customer);
  }
  const w = await workspaceForCustomer(customer);
  const due = dispute.evidence_details?.due_by;
  const [row] = await db()
    .insert(stripeMoneyEvents)
    .values({
      id: dispute.id,
      workspaceId: w?.id ?? null,
      kind,
      amountCents: dispute.amount,
      evidenceDueBy: due ? new Date(due * 1000) : null,
      outcome: kind === "dispute_closed" ? disputeOutcome(dispute.status) : null,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: stripeMoneyEvents.id });
  if (!row || kind !== "dispute_opened") return Boolean(row);
  await notifyDispute(
    dispute.id,
    {
      businessName: w?.businessName ?? null,
      amountCents: dispute.amount,
      dueBy: due ? new Date(due * 1000) : null,
      livemode: deps.livemode ?? dispute.livemode,
    },
    deps,
  );
  return true;
}

/** Once per dispute (the row insert above is the once). Never throws. */
async function notifyDispute(
  disputeId: string,
  o: { businessName: string | null; amountCents: number; dueBy: Date | null; livemode: boolean },
  deps: { send?: EmailSender },
) {
  const admin = process.env.ADMIN_EMAIL;
  if (!admin) return;
  try {
    const c = disputeNoticeCopy({
      ...o,
      dashboardUrl: `https://dashboard.stripe.com/${o.livemode ? "" : "test/"}disputes/${disputeId}`,
    });
    const { text, html } = brandEmail(c);
    await (deps.send ?? sendEmail)({
      to: admin,
      subject: c.subject,
      text,
      html,
      idempotencyKey: `dispute-${disputeId}`,
    });
  } catch (err) {
    console.error("dispute_notice_failed", { error: err instanceof Error ? err.name : "unknown" });
  }
}

/** For /admin: each workspace's refunds and disputes, newest first. Amounts and dates only. */
export async function moneyEventsFor(ids: string[]): Promise<Map<string, MoneyEventRow[]>> {
  const out = new Map<string, MoneyEventRow[]>();
  if (!ids.length) return out;
  const rows = await db()
    .select({
      id: stripeMoneyEvents.id,
      workspaceId: stripeMoneyEvents.workspaceId,
      kind: stripeMoneyEvents.kind,
      amountCents: stripeMoneyEvents.amountCents,
      includesSetup: stripeMoneyEvents.includesSetup,
      evidenceDueBy: stripeMoneyEvents.evidenceDueBy,
      outcome: stripeMoneyEvents.outcome,
      createdAt: stripeMoneyEvents.createdAt,
    })
    .from(stripeMoneyEvents)
    .where(inArray(stripeMoneyEvents.workspaceId, ids))
    .orderBy(desc(stripeMoneyEvents.createdAt));
  for (const r of rows) {
    const list = out.get(r.workspaceId!) ?? [];
    list.push(r);
    out.set(r.workspaceId!, list);
  }
  return out;
}

/** For /admin Payments: disputes opened and not yet closed, across every account. */
export async function openDisputeCount(): Promise<number> {
  const rows = await db()
    .select({ id: stripeMoneyEvents.id, kind: stripeMoneyEvents.kind })
    .from(stripeMoneyEvents)
    .where(inArray(stripeMoneyEvents.kind, ["dispute_opened", "dispute_closed"]));
  const closed = new Set(rows.filter((r) => r.kind === "dispute_closed").map((r) => r.id));
  return rows.filter((r) => r.kind === "dispute_opened" && !closed.has(r.id)).length;
}
