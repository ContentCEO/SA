import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import {
  activityLog,
  appSettings,
  drafts,
  mailboxes,
  referralCredits,
  rules,
  threads,
  users,
  workspaces,
  type Workspace,
} from "@/db/schema";
import { describeActivity } from "@/server/activity";
import { accountLockReason } from "@/server/autopilot";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { setStripeForTests, stripeMode } from "@/server/billing";
import { checkoutTerms, stripeKeyMode } from "@/server/billing-rules";
import {
  canSend,
  isReadOnly,
  jobsAllowed,
  resumeTarget,
  sendingBlockedReason,
} from "@/server/lifecycle";
import {
  checkTestPayments,
  lastTestPaymentsResult,
  resetTestPayments,
  StripeNotLiveError,
  TEST_PAYMENTS_KEY,
} from "@/server/test-payments";
import {
  parseTestPaymentsResult,
  PAST_DUE_RESET_NOTE,
  TEST_PAYMENTS_TEST_MODE,
  testPaymentReset,
  testPaymentsLine,
  testPaymentsResetNotice,
} from "@/server/test-payment-rules";
import { applyAdminMove } from "@/server/workspace-lifecycle";
import { runReferralRewards } from "@/server/referrals";
import { setReferralConfigForTests } from "@/server/referral-rules";
import { createDraftForThread } from "@/server/drafts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { listSyncableMailboxes } from "@/server/sync";
import { createTestDb } from "../support/db";
import { TERMS_VERSION } from "@/config/legal";

/**
 * "Reset test payments" (Davi, 2026-10-14). Accounts that "paid" with a Stripe test card are put
 * in the state of the 2026-10-10 precedent (no `setup_paid_via`: can't send, pays the setup fee
 * at checkout), only with the live key, one account per transaction, never over a live payment.
 */

// Built at runtime, so no file holds a key-looking string.
const LIVE_KEY = "sk_" + "live_" + "fake";
const TEST_KEY = "sk_" + "test_" + "fake";
const ADMIN = "davi@shop.com";

// The signed-in user for the action tests: requireAdmin reads the session's email, then whether
// that user agreed to the current terms (beforeEach makes Davi's user row, agreed).
const session = vi.hoisted(() => ({ email: null as string | null, id: "" }));
vi.mock("@/auth", () => ({
  auth: async () => (session.email ? { user: { id: session.id, email: session.email } } : null),
}));
class Redirected extends Error {
  constructor(readonly url: string) {
    super("redirect");
  }
}
class NotFound extends Error {}
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (url: string) => {
    throw new Redirected(url);
  },
  notFound: () => {
    throw new NotFound("not found");
  },
}));

const { checkTestPaymentsAction, resetTestPaymentsAction } =
  await import("@/app/(app)/admin/actions");

// --- A fake live Stripe account ----------------------------------------------------------------

type Known = "live" | "deleted" | "missing" | "error";
/** What live Stripe says about each id. Ids not listed are "missing" (made in test mode). */
const stripeKnows = new Map<string, Known>();
const calls: string[] = [];
/** Runs inside a retrieve, before it answers (to change the database mid-check). */
let duringRetrieve: ((id: string) => Promise<void>) | null = null;

function answer(object: "customer" | "subscription", id: string) {
  const known = stripeKnows.get(id) ?? "missing";
  if (known === "missing")
    // What live Stripe answers for a test-mode id.
    throw new Stripe.errors.StripeInvalidRequestError({
      message: `No such ${object}: '${id}'; a similar object exists in test mode`,
      code: "resource_missing",
    });
  if (known === "error")
    throw new Stripe.errors.StripeConnectionError({ message: `Stripe said ${id} owner@shop.com` });
  return known === "deleted" ? { id, object, deleted: true } : { id, object };
}

function fakeStripe() {
  const retrieve = (object: "customer" | "subscription") => async (id: string) => {
    calls.push(`${object}s.retrieve`);
    if (duringRetrieve) await duringRetrieve(id);
    return answer(object, id);
  };
  // Anything else touched counts as a call too (the refusal tests expect none at all).
  return new Proxy(
    {
      customers: { retrieve: retrieve("customer") },
      subscriptions: { retrieve: retrieve("subscription") },
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        calls.push(prop);
        return undefined;
      },
    },
  ) as unknown as Stripe;
}

// --- Accounts ----------------------------------------------------------------------------------

const NOW = new Date("2026-10-14T15:00:00Z");
const PAID_AT = new Date("2026-10-02T12:00:00Z");
let database: Database;
let n = 0;

async function account(over: Partial<Workspace>) {
  const { workspace } = await ensureUserAndWorkspace({ email: `owner${++n}@shop.com` });
  await database.update(workspaces).set(over).where(eq(workspaces.id, workspace.id));
  return workspace.id;
}
async function row(id: string) {
  return (await database.select().from(workspaces).where(eq(workspaces.id, id)))[0]!;
}
/** The fields a reset may change, to compare before and after. */
async function stripeFacts(id: string) {
  const w = await row(id);
  return {
    status: w.status,
    plan: w.plan,
    setupPaidVia: w.setupPaidVia,
    setupPaidAt: w.setupPaidAt,
    stripeCustomerId: w.stripeCustomerId,
    stripeSubscriptionId: w.stripeSubscriptionId,
  };
}
const resetRows = async (id: string) =>
  database
    .select()
    .from(activityLog)
    .where(eq(activityLog.workspaceId, id))
    .then((rows) => rows.filter((r) => r.action === "test_payment_reset"));

/** A test-card payment as the webhook left it: setup paid through Stripe, test-mode ids. */
const testPaid = (status: Workspace["status"], over: Partial<Workspace> = {}) =>
  account({
    status,
    plan: "crew",
    setupPaidVia: "stripe",
    setupPaidAt: PAID_AT,
    stripeCustomerId: `cus_test${n + 1}`,
    stripeSubscriptionId: `sub_test${n + 1}`,
    ...over,
  });

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.ADMIN_EMAIL = ADMIN;
  vi.stubEnv("STRIPE_SECRET_KEY", LIVE_KEY);
  database = await createTestDb();
  stripeKnows.clear();
  calls.length = 0;
  duringRetrieve = null;
  session.email = ADMIN;
  const [admin] = await database
    .insert(users)
    .values({ email: ADMIN, termsAcceptedAt: NOW, termsVersion: TERMS_VERSION })
    .returning();
  session.id = admin!.id;
  setStripeForTests(fakeStripe());
});
afterEach(() => {
  setStripeForTests(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("only with the live key", () => {
  it("live = sk_live_ or rk_live_; anything else set is test; unset is null", () => {
    expect(stripeKeyMode(LIVE_KEY)).toBe("live");
    expect(stripeKeyMode("rk_" + "live_" + "fake")).toBe("live");
    expect(stripeKeyMode(TEST_KEY)).toBe("test");
    expect(stripeKeyMode("rk_" + "test_" + "fake")).toBe("test");
    expect(stripeKeyMode("sk_livefake")).toBe("test");
    expect(stripeKeyMode("")).toBeNull();
    expect(stripeKeyMode(undefined)).toBeNull();
    // Connect Stripe's "connected in LIVE mode" notice reads the same rule.
    const billing = readFileSync("src/server/billing.ts", "utf8");
    expect(billing).toContain('mode: stripeMode() === "live" ? "live" : "test"');
    expect(billing).not.toMatch(/startsWith\("sk_live/);
  });

  it("with a test key (or none), check and reset refuse before any Stripe call", async () => {
    const id = await testPaid("setup_paid");
    const before = await stripeFacts(id);
    for (const key of [TEST_KEY, ""]) {
      vi.stubEnv("STRIPE_SECRET_KEY", key);
      expect(stripeMode()).not.toBe("live");
      await expect(resetTestPayments(NOW)).rejects.toBeInstanceOf(StripeNotLiveError);
      await expect(checkTestPayments(NOW)).rejects.toBeInstanceOf(StripeNotLiveError);
    }
    expect(calls).toEqual([]);
    expect(await stripeFacts(id)).toEqual(before);
    expect(await resetRows(id)).toEqual([]);
    expect(await lastTestPaymentsResult()).toBeNull();
  });

  it("the actions send a test-mode tap back with the test-mode sentence, nothing changed", async () => {
    const id = await testPaid("active");
    const before = await stripeFacts(id);
    vi.stubEnv("STRIPE_SECRET_KEY", TEST_KEY);
    for (const action of [resetTestPaymentsAction, checkTestPaymentsAction]) {
      await expect(action()).rejects.toMatchObject({
        url: "/admin?error=stripe_test_mode#stripe",
      });
    }
    expect(calls).toEqual([]);
    expect(await stripeFacts(id)).toEqual(before);
    const page = readFileSync("src/app/(app)/admin/page.tsx", "utf8");
    expect(page).toContain("stripe_test_mode: TEST_PAYMENTS_TEST_MODE");
    expect(TEST_PAYMENTS_TEST_MODE).toBe(
      "Reset test payments shows up after you switch Stripe to live mode.",
    );
  });
});

describe("only Davi", () => {
  it("anyone else gets a 404 from both actions, before anything is read or changed", async () => {
    const id = await testPaid("setup_paid");
    const before = await stripeFacts(id);
    for (const email of ["owner1@shop.com", null]) {
      session.email = email;
      for (const action of [resetTestPaymentsAction, checkTestPaymentsAction]) {
        await expect(action()).rejects.toBeInstanceOf(NotFound);
      }
    }
    expect(calls).toEqual([]);
    expect(await stripeFacts(id)).toEqual(before);
    expect(await lastTestPaymentsResult()).toBeNull();
  });

  it("Davi's reset ends on the Payments card with the done code", async () => {
    await testPaid("setup_paid");
    await expect(resetTestPaymentsAction()).rejects.toMatchObject({
      url: "/admin?done=stripe_test_reset#stripe",
    });
    await expect(checkTestPaymentsAction()).rejects.toMatchObject({
      url: "/admin?done=stripe_test_check#stripe",
    });
  });
});

describe("resetting", () => {
  it("a test-card setup goes back to unpaid: can't send, sees the precedent's words, pays the setup fee", async () => {
    const setupPaid = await testPaid("setup_paid");
    const active = await testPaid("active", { setupCallCompletedAt: PAID_AT });

    expect(await resetTestPayments(NOW)).toEqual({ reset: 2, unchecked: 0 });

    for (const [id, status] of [
      [setupPaid, "setup_paid"],
      [active, "active"],
    ] as const) {
      const w = await row(id);
      expect(w).toMatchObject({
        status, // kept (the 2026-10-10 precedent)
        plan: "crew", // kept: the next checkout sets it
        setupPaidVia: null,
        // Kept, like the precedent's hand-marked accounts: Resume reads it, nothing reads it as
        // "paid", and a real payment records its own date.
        setupPaidAt: PAID_AT,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
      });
      expect(canSend(w, NOW)).toBe(false);
      expect(sendingBlockedReason(w, NOW)).toBe(
        "Sending turns on once your setup payment goes through. Choose a plan in Settings → Plan & billing.",
      );
      expect(checkoutTerms(w, NOW)).toEqual({ allowed: true, includeSetupFee: true });
      // One content-free activity row: booleans only.
      const [log] = await resetRows(id);
      expect(log!.actor).toBe("squared_away");
      expect(log!.detail).toEqual({
        customerCleared: true,
        subscriptionCleared: true,
        setupPaymentCleared: true,
        statusRestored: false,
      });
      expect(Object.values(log!.detail).every((v) => typeof v === "boolean")).toBe(true);
      expect(describeActivity(log!.action, log!.detail, null)).toBe(
        "Your test payment was cleared — the setup fee is still due",
      );
    }
  });

  it("a paused test-paid account resumes to where it was, still unable to send", async () => {
    const paused = await testPaid("paused");
    const pausedCallDone = await testPaid("paused", { setupCallCompletedAt: PAID_AT });
    // The same account, not paused, keeps setup_paid: Resume must bring the paused one there too.
    const notPaused = await testPaid("setup_paid");
    expect(await resetTestPayments(NOW)).toEqual({ reset: 3, unchecked: 0 });

    expect((await row(paused)).status).toBe("paused");
    expect(resumeTarget(await row(paused), NOW)).toBe((await row(notPaused)).status);
    expect(await applyAdminMove(paused, "resume", NOW)).toBe("setup_paid");
    expect(await applyAdminMove(pausedCallDone, "resume", NOW)).toBe("active");
    for (const id of [paused, pausedCallDone]) {
      const w = await row(id);
      expect(jobsAllowed(w, NOW)).toBe(true); // not read-only
      expect(canSend(w, NOW)).toBe(false); // still has to pay for real
      expect(checkoutTerms(w, NOW)).toEqual({ allowed: true, includeSetupFee: true });
    }
    // While paused, checkout is refused, so Activity never says "choose a plan".
    const [log] = await resetRows(paused);
    expect(describeActivity(log!.action, log!.detail, null)).not.toMatch(/choose a plan/i);
  });

  it("a setup paid through Stripe with no ids at all was a test payment (a live one leaves a customer)", async () => {
    const id = await testPaid("setup_paid", { stripeCustomerId: null, stripeSubscriptionId: null });
    expect(await resetTestPayments(NOW)).toEqual({ reset: 1, unchecked: 0 });
    expect(calls).toEqual([]); // nothing to ask Stripe about
    expect(await row(id)).toMatchObject({ setupPaidVia: null, setupPaidAt: PAID_AT });
    expect(canSend(await row(id), NOW)).toBe(false);
  });

  it("a live customer is left alone (and a deleted live customer is still live)", async () => {
    stripeKnows.set("cus_live", "live");
    stripeKnows.set("sub_live", "live");
    stripeKnows.set("cus_gone", "deleted");
    const live = await testPaid("active", {
      stripeCustomerId: "cus_live",
      stripeSubscriptionId: "sub_live",
    });
    const deleted = await testPaid("canceled", {
      stripeCustomerId: "cus_gone",
      stripeSubscriptionId: null,
    });
    const before = [await stripeFacts(live), await stripeFacts(deleted)];

    expect(await resetTestPayments(NOW)).toEqual({ reset: 0, unchecked: 0 });
    expect([await stripeFacts(live), await stripeFacts(deleted)]).toEqual(before);
    expect(await resetRows(live)).toEqual([]);
    expect(await resetRows(deleted)).toEqual([]);
    expect(calls.sort()).toEqual(
      ["customers.retrieve", "customers.retrieve", "subscriptions.retrieve"].sort(),
    );
  });

  it("a live customer with a leftover test subscription keeps its setup payment; only the test id goes", async () => {
    stripeKnows.set("cus_live", "live");
    const id = await testPaid("setup_paid", {
      stripeCustomerId: "cus_live",
      stripeSubscriptionId: "sub_test_old",
    });
    expect(await resetTestPayments(NOW)).toEqual({ reset: 1, unchecked: 0 });
    expect(await row(id)).toMatchObject({
      stripeCustomerId: "cus_live",
      stripeSubscriptionId: null,
      setupPaidVia: "stripe",
      setupPaidAt: PAID_AT,
      status: "setup_paid",
    });
    // Nothing the owner can see changed, so Activity says nothing.
    const [log] = await resetRows(id);
    expect(describeActivity(log!.action, log!.detail, null)).toBeNull();
  });

  it("Davi's house account loses only its test-mode ids and keeps sending", async () => {
    const id = await testPaid("active", { setupPaidVia: "house" });
    expect(await resetTestPayments(NOW)).toEqual({ reset: 1, unchecked: 0 });
    const w = await row(id);
    expect(w).toMatchObject({
      status: "active",
      setupPaidVia: "house",
      setupPaidAt: PAID_AT,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });
    expect(canSend(w, NOW)).toBe(true);
    expect((await resetRows(id))[0]!.detail).toMatchObject({ setupPaymentCleared: false });
  });

  it("past due goes where a recovered payment would (a test subscription can never be paid)", async () => {
    const noCall = await testPaid("past_due");
    const callDone = await testPaid("past_due", { setupCallCompletedAt: PAID_AT });
    expect(jobsAllowed(await row(noCall), NOW)).toBe(false); // read-only before
    expect(await resetTestPayments(NOW)).toEqual({ reset: 2, unchecked: 0 });
    expect((await row(noCall)).status).toBe("setup_paid");
    expect((await row(callDone)).status).toBe("active");
    for (const id of [noCall, callDone]) {
      const w = await row(id);
      expect(canSend(w, NOW)).toBe(false); // still has to pay for real
      expect(checkoutTerms(w, NOW)).toEqual({ allowed: true, includeSetupFee: true });
      expect((await resetRows(id))[0]!.detail).toMatchObject({ statusRestored: true });
      // …but it leaves read-only without a payment: sorting and drafting (AI) start again.
      expect(jobsAllowed(w, NOW)).toBe(true);
    }
    // That move is said in plain words where Davi taps Reset and in the launch checklist, and step 13
    // asks whether it's okay (review, 2026-10-15).
    expect(PAST_DUE_RESET_NOTE).toContain("sorted and drafted again");
    expect(PAST_DUE_RESET_NOTE).toContain("can't send until it pays");
    const page = readFileSync("src/app/(app)/admin/page.tsx", "utf8");
    expect(page).toContain("<p>{PAST_DUE_RESET_NOTE}</p>");
    const launch = readFileSync("docs/LAUNCH.md", "utf8").replace(/\s+/g, " ");
    const reset = launch.slice(launch.indexOf("**7c. Reset test payments.**"));
    expect(reset.slice(0, reset.indexOf("**7d."))).toContain(PAST_DUE_RESET_NOTE);
    // Davi, 2026-10-16: "let it be usable" — decided, no longer an open question.
    const decided = launch.slice(
      launch.indexOf("### Decided on 2026-10-16"),
      launch.indexOf("### Decided on 2026-10-15"),
    );
    expect(decided).toContain("**Reset test payments and past-due accounts: let it be usable**");
    const open = launch.slice(launch.indexOf("### Still open"), launch.indexOf("### Still needed"));
    expect(open).not.toContain("Reset test payments and past-due");
  });

  it("Davi 2026-10-16 'let it be usable': a past-due test account works again everywhere but Send", async () => {
    const id = await testPaid("past_due");
    const box = await saveConnectedMailbox(
      { id, plan: "crew", freePlan: null, freePlanUntil: null },
      { email: "pastdue@shop.com", refreshToken: "rt", grantedScopes: [] },
    );
    await database
      .update(mailboxes)
      .set({ backfillCompletedAt: PAID_AT })
      .where(eq(mailboxes.id, box.id));
    // Before: read-only — not synced, no drafts.
    expect((await listSyncableMailboxes(NOW)).map((b) => b.id)).not.toContain(box.id);
    expect(await resetTestPayments(NOW)).toEqual({ reset: 1, unchecked: 0 });
    const w = await row(id);
    expect(w.status).toBe("setup_paid"); // where a recovered payment would put it
    expect(isReadOnly(w, NOW)).toBe(false);
    // Its Gmail is read again and an owner's tap is no longer refused as read-only…
    expect((await listSyncableMailboxes(NOW)).map((b) => b.id)).toContain(box.id);
    const [t] = await database
      .insert(threads)
      .values({ mailboxId: box.id, gmailThreadId: "pd1", inInbox: true })
      .returning();
    const tap = await createDraftForThread(t!.id, { trigger: "owner", workspaceId: id });
    expect(tap).not.toEqual({ status: "skipped", reason: "read_only" });
    // …but nothing is sent until it really pays (the send gate reads setup_paid_via).
    expect(canSend(w, NOW)).toBe(false);
    expect(sendingBlockedReason(w, NOW)).toBe(
      "Sending turns on once your setup payment goes through. Choose a plan in Settings → Plan & billing.",
    );
    expect(checkoutTerms(w, NOW)).toEqual({ allowed: true, includeSetupFee: true });
  });

  it("every other status stays as it is", async () => {
    const later = new Date(NOW.getTime() + 86_400_000);
    const ids = {
      evaluating: await account({
        status: "evaluating",
        evaluationEndsAt: later,
        stripeCustomerId: "cus_test_started_checkout",
      }),
      evaluation_expired: await account({
        status: "evaluation_expired",
        evaluationEndsAt: NOW,
        stripeCustomerId: "cus_test_e",
      }),
      canceled: await testPaid("canceled", { stripeSubscriptionId: null }),
      paused: await testPaid("paused"),
      invited: await account({ status: "invited", stripeCustomerId: "cus_test_i" }),
    };
    expect(await resetTestPayments(NOW)).toEqual({ reset: 5, unchecked: 0 });
    for (const [status, id] of Object.entries(ids)) {
      const w = await row(id);
      expect(w.status, status).toBe(status);
      expect(w.stripeCustomerId, status).toBeNull();
      expect(w.stripeSubscriptionId, status).toBeNull();
      expect(w.setupPaidVia, status).toBeNull();
    }
    // A canceled test-paid account pays the setup fee when it comes back.
    expect(checkoutTerms(await row(ids.canceled), NOW).includeSetupFee).toBe(true);
  });

  it("any other Stripe error leaves the whole account unchanged and counts it", async () => {
    stripeKnows.set("cus_flaky", "error");
    stripeKnows.set("sub_flaky", "error");
    // Customer is a test id, but the subscription can't be checked: nothing is half-done.
    const half = await testPaid("setup_paid", { stripeSubscriptionId: "sub_flaky" });
    const flaky = await testPaid("active", { stripeCustomerId: "cus_flaky" });
    const fine = await testPaid("setup_paid");
    const before = [await stripeFacts(half), await stripeFacts(flaky)];
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});

    expect(await resetTestPayments(NOW)).toEqual({ reset: 1, unchecked: 2 });
    expect([await stripeFacts(half), await stripeFacts(flaky)]).toEqual(before);
    expect((await row(fine)).setupPaidVia).toBeNull();
    // Counts only in the log, never Stripe's words.
    expect(logged).toHaveBeenCalledWith("test_payments_reset", {
      reset: 1,
      unchecked: 2,
      rewardsCleared: 0,
    });
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/owner@|cus_|sub_/);

    // Stripe answers on the next tap: the rest is reset, the done one isn't touched twice.
    stripeKnows.delete("cus_flaky");
    stripeKnows.delete("sub_flaky");
    expect(await resetTestPayments(NOW)).toEqual({ reset: 2, unchecked: 0 });
    expect(await resetRows(fine)).toHaveLength(1);
  });

  it("an account whose ids change between the check and the update is left alone", async () => {
    const id = await testPaid("setup_paid");
    // A live checkout finishes while Stripe is being asked about the old id.
    duringRetrieve = async (stripeId) => {
      if (stripeId.startsWith("cus_test")) {
        await database
          .update(workspaces)
          .set({ stripeCustomerId: "cus_live_new", stripeSubscriptionId: "sub_live_new" })
          .where(eq(workspaces.id, id));
      }
    };
    expect(await resetTestPayments(NOW)).toEqual({ reset: 0, unchecked: 1 });
    expect(await row(id)).toMatchObject({
      stripeCustomerId: "cus_live_new",
      stripeSubscriptionId: "sub_live_new",
      setupPaidVia: "stripe",
      setupPaidAt: PAID_AT,
    });
    expect(await resetRows(id)).toEqual([]);
  });

  it("a status change in between is not overwritten either", async () => {
    const id = await testPaid("past_due");
    duringRetrieve = async () => {
      await database.update(workspaces).set({ status: "paused" }).where(eq(workspaces.id, id));
    };
    expect(await resetTestPayments(NOW)).toEqual({ reset: 0, unchecked: 1 });
    expect((await row(id)).status).toBe("paused");
  });

  it("is safe to tap again: the second run finds nothing", async () => {
    const id = await testPaid("setup_paid");
    await resetTestPayments(NOW);
    calls.length = 0;
    expect(await resetTestPayments(NOW)).toEqual({ reset: 0, unchecked: 0 });
    expect(calls).toEqual([]); // nothing left to ask about
    expect(await resetRows(id)).toHaveLength(1);
  });

  it("plan #47: free months earned in test mode go (a running one stops); live ones stay", async () => {
    const referrer = await account({
      status: "active",
      plan: "solo",
      setupPaidVia: "stripe",
      setupPaidAt: PAID_AT,
      stripeCustomerId: "cus_live_ref",
      stripeSubscriptionId: "sub_live_ref",
      freePlan: "crew",
      freePlanUntil: new Date(NOW.getTime() + 86_400_000),
    });
    stripeKnows.set("cus_live_ref", "live");
    stripeKnows.set("sub_live_ref", "live");
    await database.insert(rules).values({
      workspaceId: referrer,
      category: "scheduling",
      mode: "autopilot",
    });
    const base = {
      beneficiaryWorkspaceId: referrer,
      side: "referrer" as const,
      amountCents: 0,
      reward: "free_month_up" as const,
    };
    await database.insert(referralCredits).values([
      {
        ...base,
        referredEmailSha256: "t1",
        status: "running",
        stripeMode: "test",
        freePlan: "crew",
      },
      { ...base, referredEmailSha256: "t2", status: "pending", stripeMode: "test" },
      { ...base, referredEmailSha256: "l1", status: "pending", stripeMode: "live" },
    ]);
    await database.insert(appSettings).values([
      { key: "stripe_portal_no_plan_change:test", value: '{"id":"bpc_t","defaultUpdated":1}' },
      { key: "stripe_portal_no_plan_change:live", value: '{"id":"bpc_l","defaultUpdated":1}' },
    ]);
    await resetTestPayments(NOW);
    // The test key's cached billing-page settings go; the live key's stay.
    const portals = await database.select({ key: appSettings.key }).from(appSettings);
    expect(portals.map((p) => p.key)).not.toContain("stripe_portal_no_plan_change:test");
    expect(portals.map((p) => p.key)).toContain("stripe_portal_no_plan_change:live");
    const left = await database.select().from(referralCredits);
    expect(left.map((r) => r.referredEmailSha256)).toEqual(["l1"]);
    const w = await row(referrer);
    expect(w).toMatchObject({ freePlan: null, freePlanUntil: null, plan: "solo" });
    // The month's end effects ran with it: Solo has no autopilot.
    const [rule] = await database.select().from(rules).where(eq(rules.workspaceId, referrer));
    expect(rule!.mode).toBe("draft");
  });

  it("plan #47: a test reward stays while its referred account couldn't be reset (never re-settled live)", async () => {
    const referrer = await account({
      status: "active",
      plan: "solo",
      setupPaidVia: "stripe",
      stripeCustomerId: "cus_live_ref2",
      stripeSubscriptionId: "sub_live_ref2",
    });
    stripeKnows.set("cus_live_ref2", "live");
    stripeKnows.set("sub_live_ref2", "live");
    // Two referred owners on another domain (so no same-domain skip), both paid with a test card.
    const referred = async (email: string, customer: string) => {
      const { workspace } = await ensureUserAndWorkspace({ email });
      await database
        .update(workspaces)
        .set({
          status: "active",
          plan: "solo",
          setupPaidVia: "stripe",
          setupPaidAt: PAID_AT,
          stripeCustomerId: customer,
          stripeSubscriptionId: null,
          referredByWorkspaceId: referrer,
        })
        .where(eq(workspaces.id, workspace.id));
      return workspace.id;
    };
    const flaky = await referred("dana@customer-one.com", "cus_flaky_ref");
    const reset = await referred("mike@customer-two.com", "cus_test_ref");
    stripeKnows.set("cus_flaky_ref", "error");
    const base = {
      beneficiaryWorkspaceId: referrer,
      side: "referrer" as const,
      amountCents: 0,
      reward: "free_month_up" as const,
      status: "pending" as const,
      stripeMode: "test" as const,
    };
    await database.insert(referralCredits).values([
      { ...base, referredWorkspaceId: flaky, referredEmailSha256: "flaky" },
      { ...base, referredWorkspaceId: reset, referredEmailSha256: "reset" },
    ]);

    expect(await resetTestPayments(NOW)).toEqual({ reset: 1, unchecked: 1 });
    // Only the reset account's reward went; the unchecked one keeps its fingerprint row.
    const left = await database.select().from(referralCredits);
    expect(left.map((r) => [r.referredWorkspaceId, r.stripeMode])).toEqual([[flaky, "test"]]);

    // With referrals on, the sweep finds nothing to settle again on the live key.
    vi.stubEnv("FEATURE_REFERRALS", "1");
    setReferralConfigForTests({ reward: "free_month_one_plan_up" });
    try {
      await runReferralRewards(new Date(NOW.getTime() + 15 * 60_000));
    } finally {
      setReferralConfigForTests(undefined);
    }
    const after = await database.select().from(referralCredits);
    expect(after.filter((r) => r.stripeMode === "live")).toEqual([]);
    expect(after.filter((r) => r.referredWorkspaceId === flaky)).toHaveLength(1);

    // Once Stripe answers and the account is reset, its test reward goes too.
    stripeKnows.delete("cus_flaky_ref");
    expect(await resetTestPayments(NOW)).toEqual({ reset: 1, unchecked: 0 });
    expect(
      (await database.select().from(referralCredits)).filter((r) => r.stripeMode === "test"),
    ).toEqual([]);
  });

  it("stops any autopilot countdown on a reset account", async () => {
    const id = await testPaid("active");
    const other = await account({ status: "active", setupPaidVia: "house" });
    const countdown = async (workspaceId: string) => {
      const [mb] = await database
        .insert(mailboxes)
        .values({
          workspaceId,
          email: `${workspaceId}@shop.com`,
          encryptedRefreshToken: "x",
          scopes: "x",
        })
        .returning();
      const [t] = await database
        .insert(threads)
        .values({
          mailboxId: mb!.id,
          gmailThreadId: `t-${workspaceId}`,
          inInbox: true,
          subject: "Visit",
        })
        .returning();
      const [d] = await database
        .insert(drafts)
        .values({
          threadId: t!.id,
          mailboxId: mb!.id,
          gmailDraftId: `d-${workspaceId}`,
          toAddress: "dana@customer.com",
          subject: "Re: Visit",
          body: "Thursday works.",
          originalBody: "Thursday works.",
          status: "pending",
          reason: "Scheduling.",
          promptVersion: "draft.v5",
          autoSendAt: new Date(NOW.getTime() + 5 * 60_000),
        })
        .returning();
      return d!.id;
    };
    const mine = await countdown(id);
    const theirs = await countdown(other);
    await database
      .insert(rules)
      .values({ workspaceId: id, category: "scheduling", mode: "autopilot", updatedAt: NOW });
    await resetTestPayments(NOW);
    const at = async (draftId: string) =>
      (await database.select().from(drafts).where(eq(drafts.id, draftId)))[0]!.autoSendAt;
    expect(await at(mine)).toBeNull();
    expect(await at(theirs)).not.toBeNull(); // other accounts keep theirs

    // And the account layer now refuses autopilot: it needs a real payment too (otherwise it
    // would count down to a send the gate refuses, again and again). That a refused account
    // layer really stops a countdown that every other layer allows is shown in
    // autopilot.test.ts ("an active account without a real setup payment never starts a
    // countdown"); this thread wouldn't pass the category and per-email layers anyway.
    expect(accountLockReason(await row(id), NOW)).toBe(
      "Autopilot opens up once your setup payment goes through.",
    );
    // The owner's switch is kept for when they pay.
    expect((await database.select().from(rules).where(eq(rules.workspaceId, id)))[0]!.mode).toBe(
      "autopilot",
    );
  });
});

describe("what /admin shows", () => {
  it("a check asks Stripe, changes nothing, and keeps only the counts", async () => {
    stripeKnows.set("cus_live", "live");
    stripeKnows.set("cus_flaky", "error");
    const a = await testPaid("setup_paid");
    const b = await testPaid("active");
    await testPaid("active", { stripeCustomerId: "cus_live", stripeSubscriptionId: null });
    await testPaid("active", { stripeCustomerId: "cus_flaky", stripeSubscriptionId: null });
    const before = [await stripeFacts(a), await stripeFacts(b)];

    const result = await checkTestPayments(NOW);
    expect(result).toEqual({ found: 2, unchecked: 1, reset: null, at: NOW.toISOString() });
    expect([await stripeFacts(a), await stripeFacts(b)]).toEqual(before);

    // The page reads it back from the database, with no Stripe call.
    calls.length = 0;
    expect(await lastTestPaymentsResult()).toEqual(result);
    expect(calls).toEqual([]);
    const [stored] = await database
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, TEST_PAYMENTS_KEY));
    expect(stored!.value).not.toMatch(/cus_|sub_|@/);
    expect(testPaymentsLine(result)).toBe(
      "Test payments: 2 accounts still carry a test-mode payment. Couldn't check 1 account. Tap again.",
    );

    // After a reset, the card shows what's left and the notice what was done.
    stripeKnows.delete("cus_flaky");
    await resetTestPayments(NOW);
    const after = (await lastTestPaymentsResult())!;
    expect(after).toMatchObject({ found: 0, unchecked: 0, reset: 3 });
    expect(testPaymentsLine(after)).toBe("Test payments: none left.");
    expect(testPaymentsResetNotice({ reset: after.reset!, unchecked: after.unchecked })).toBe(
      "Test payments reset for 3 accounts.",
    );
  });

  it("the wording, singular and plural", () => {
    expect(testPaymentsLine({ found: 1, unchecked: 0 })).toBe(
      "Test payments: 1 account still carries a test-mode payment.",
    );
    expect(testPaymentsLine({ found: 0, unchecked: 2 })).toBe(
      "Test payments: none found so far. Couldn't check 2 accounts. Tap again.",
    );
    expect(testPaymentsResetNotice({ reset: 1, unchecked: 0 })).toBe(
      "Test payments reset for 1 account.",
    );
    expect(testPaymentsResetNotice({ reset: 4, unchecked: 1 })).toBe(
      "Test payments reset for 4 accounts. Couldn't check 1 account. Tap again.",
    );
  });

  it("a malformed stored value reads as never checked", () => {
    for (const v of [null, "", "nope", "{}", '{"found":-1,"unchecked":0,"reset":null,"at":"x"}']) {
      expect(parseTestPaymentsResult(v)).toBeNull();
    }
    expect(
      parseTestPaymentsResult('{"found":1,"unchecked":0,"reset":null,"at":"2026-10-14T15:00:00Z"}'),
    ).toEqual({ found: 1, unchecked: 0, reset: null, at: "2026-10-14T15:00:00Z" });
  });

  it("the page puts the reset behind one confirmation and only shows it in live mode", () => {
    const page = readFileSync("src/app/(app)/admin/page.tsx", "utf8");
    const block = page.slice(page.indexOf("function TestPayments("));
    expect(block).toMatch(
      /<summary[^>]*>\s*Reset test payments\s*<\/summary>\s*<form action=\{resetTestPaymentsAction\}/,
    );
    expect(block).toContain("Yes, reset test payments");
    expect(block).toContain("Check test payments");
    expect(page).toContain(
      "{live ? <TestPayments result={testPayments} /> : <p>{TEST_PAYMENTS_TEST_MODE}</p>}",
    );
    // A plain page load only reads the stored counts (no Stripe call) and only in live mode.
    expect(page).toContain("live ? lastTestPaymentsResult() : null");
  });
});

describe("rules", () => {
  const w = (over: Partial<Workspace> = {}) => ({
    status: "setup_paid" as Workspace["status"],
    setupPaidVia: "stripe" as Workspace["setupPaidVia"],
    setupPaidAt: PAID_AT,
    setupCallCompletedAt: null,
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: "sub_1",
    ...over,
  });

  it("nothing test-mode, nothing to do; anything unknown, nothing at all", () => {
    expect(testPaymentReset(w(), { customer: "live", subscription: "live" })).toBeNull();
    expect(
      testPaymentReset(w({ setupPaidVia: null }), { customer: "none", subscription: "none" }),
    ).toBeNull();
    expect(testPaymentReset(w(), { customer: "test", subscription: "unknown" })).toBe("unchecked");
    expect(testPaymentReset(w(), { customer: "unknown", subscription: "test" })).toBe("unchecked");
  });

  it("a live subscription also counts as a live payment (setup kept, past due kept)", () => {
    const r = testPaymentReset(w({ status: "past_due" }), {
      customer: "test",
      subscription: "live",
    });
    expect(r).not.toBe("unchecked");
    expect(r && r !== "unchecked" ? r.set : null).toMatchObject({
      status: "past_due",
      setupPaidVia: "stripe",
      stripeCustomerId: null,
      stripeSubscriptionId: "sub_1",
    });
  });
});
