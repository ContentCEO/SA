import "server-only";
import { and, eq, isNotNull, isNull, or, type Column, type SQL } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "@/db";
import { activityLog, appSettings, workspaces } from "@/db/schema";
import { stripeClient, stripeMode } from "./billing";
import {
  mayCarryTestPayment,
  parseTestPaymentsResult,
  testPaymentReset,
  type IdCheck,
  type TestPaymentReset,
  type TestPaymentsResult,
} from "./test-payment-rules";
import { clearAutopilotCountdowns } from "./workspace-lifecycle";

/**
 * "Reset test payments" in /admin → Payments (Davi, 2026-10-14). Once Stripe runs on the live
 * key, every customer or subscription id live Stripe doesn't know came from test mode. Accounts
 * carrying one are reset by the rules in `test-payment-rules.ts`, so they pay for real.
 *
 * Only with a live key: in test mode every id is a test id and nothing could be told apart.
 * Plain page loads make no Stripe calls: the last check's counts are kept in `app_settings`.
 */

/** The last check or reset (counts only, no ids), shown on the /admin Payments card. */
export const TEST_PAYMENTS_KEY = "stripe_test_payments";

export class StripeNotLiveError extends Error {
  constructor() {
    super("Test payments can only be told apart with the live Stripe key.");
    this.name = "StripeNotLiveError";
  }
}

const STRIPE_CALL: Stripe.RequestOptions = { timeout: 10_000, maxNetworkRetries: 1 };
/** Accounts checked at once (two Stripe calls each at most). */
const AT_ONCE = 4;

/**
 * Live Stripe on one stored id. `resource_missing` = Stripe doesn't know it, so it was made in
 * test mode. A deleted live customer comes back `{ deleted: true }`: that's live, not test.
 */
async function checkId(kind: "customer" | "subscription", id: string | null): Promise<IdCheck> {
  if (!id) return "none";
  const s = stripeClient();
  try {
    if (kind === "customer") await s.customers.retrieve(id, {}, STRIPE_CALL);
    else await s.subscriptions.retrieve(id, {}, STRIPE_CALL);
    return "live";
  } catch (err) {
    return (err as { code?: unknown } | null)?.code === "resource_missing" ? "test" : "unknown";
  }
}

async function candidates() {
  const rows = await db()
    .select({
      id: workspaces.id,
      status: workspaces.status,
      setupPaidVia: workspaces.setupPaidVia,
      setupPaidAt: workspaces.setupPaidAt,
      setupCallCompletedAt: workspaces.setupCallCompletedAt,
      stripeCustomerId: workspaces.stripeCustomerId,
      stripeSubscriptionId: workspaces.stripeSubscriptionId,
    })
    .from(workspaces)
    .where(
      or(
        isNotNull(workspaces.stripeCustomerId),
        isNotNull(workspaces.stripeSubscriptionId),
        eq(workspaces.setupPaidVia, "stripe"),
      ),
    );
  return rows.filter(mayCarryTestPayment);
}

type Candidate = Awaited<ReturnType<typeof candidates>>[number];
type Checked = { w: Candidate; outcome: TestPaymentReset | "unchecked" | null };

async function checkAll(): Promise<Checked[]> {
  const rows = await candidates();
  const out: Checked[] = [];
  for (let i = 0; i < rows.length; i += AT_ONCE) {
    out.push(
      ...(await Promise.all(
        rows.slice(i, i + AT_ONCE).map(async (w) => {
          const [customer, subscription] = await Promise.all([
            checkId("customer", w.stripeCustomerId),
            checkId("subscription", w.stripeSubscriptionId),
          ]);
          return { w, outcome: testPaymentReset(w, { customer, subscription }) };
        }),
      )),
    );
  }
  return out;
}

function requireLiveMode() {
  if (stripeMode() !== "live") throw new StripeNotLiveError();
}

async function keep(result: TestPaymentsResult, now: Date) {
  const value = JSON.stringify(result);
  await db()
    .insert(appSettings)
    .values({ key: TEST_PAYMENTS_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } });
}

/** The last check or reset, from the database only (no Stripe call). Null if never. */
export async function lastTestPaymentsResult(): Promise<TestPaymentsResult | null> {
  const [row] = await db()
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, TEST_PAYMENTS_KEY));
  return parseTestPaymentsResult(row?.value);
}

/** "Check test payments": asks live Stripe, changes no account, keeps the counts. */
export async function checkTestPayments(now: Date = new Date()): Promise<TestPaymentsResult> {
  requireLiveMode();
  const checked = await checkAll();
  const result: TestPaymentsResult = {
    found: checked.filter((c) => c.outcome !== null && c.outcome !== "unchecked").length,
    unchecked: checked.filter((c) => c.outcome === "unchecked").length,
    reset: null,
    at: now.toISOString(),
  };
  await keep(result, now);
  console.info("test_payments_checked", { found: result.found, unchecked: result.unchecked });
  return result;
}

const same = (column: Column, value: string | null): SQL =>
  value === null ? isNull(column) : eq(column, value);

/**
 * One account, in one transaction. The UPDATE only lands if the row still holds exactly what was
 * checked (ids, how setup was paid, status, setup call), so a live checkout finishing meanwhile
 * is never overwritten. Returns false when it changed (left as it is; counted as not checked).
 */
async function resetOne(w: Candidate, r: TestPaymentReset): Promise<boolean> {
  return db().transaction(async (tx) => {
    const [row] = await tx
      .update(workspaces)
      .set(r.set)
      .where(
        and(
          eq(workspaces.id, w.id),
          same(workspaces.stripeCustomerId, w.stripeCustomerId),
          same(workspaces.stripeSubscriptionId, w.stripeSubscriptionId),
          same(workspaces.setupPaidVia, w.setupPaidVia),
          eq(workspaces.status, w.status),
          w.setupCallCompletedAt
            ? isNotNull(workspaces.setupCallCompletedAt)
            : isNull(workspaces.setupCallCompletedAt),
        ),
      )
      .returning({ id: workspaces.id });
    if (!row) return false;
    // Nothing counts down to an autopilot send on an account whose payment just went.
    await clearAutopilotCountdowns(w.id, tx);
    await tx.insert(activityLog).values({
      workspaceId: w.id,
      actor: "squared_away",
      action: "test_payment_reset",
      detail: r.detail,
    });
    return true;
  });
}

/**
 * "Reset test payments": checks every candidate with live Stripe again, then resets each
 * test-paid account on its own. An account Stripe couldn't answer for, or that changed while we
 * looked, is left exactly as it was and counted as not checked. Safe to run again.
 */
export async function resetTestPayments(
  now: Date = new Date(),
): Promise<{ reset: number; unchecked: number }> {
  requireLiveMode();
  const checked = await checkAll();
  let reset = 0;
  let unchecked = 0;
  for (const { w, outcome } of checked) {
    if (outcome === null) continue;
    if (outcome === "unchecked") {
      unchecked++;
      continue;
    }
    try {
      if (await resetOne(w, outcome)) reset++;
      else unchecked++;
    } catch (err) {
      unchecked++;
      console.error("test_payment_reset_failed", {
        workspaceId: w.id,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  // Everything found was reset; what's left is only what couldn't be checked.
  await keep({ found: 0, unchecked, reset, at: now.toISOString() }, now);
  console.info("test_payments_reset", { reset, unchecked });
  return { reset, unchecked };
}
