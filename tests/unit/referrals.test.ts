import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REFERRAL_REWARD } from "@/config/pricing";
import { setDbForTests, type Database } from "@/db";
import {
  activityLog,
  appSettings,
  invites,
  referralCredits,
  users,
  waitlist,
  workspaces,
  type Workspace,
} from "@/db/schema";
import { encryptSecret } from "@/lib/crypto";
import type { MailboxConnector } from "@/mailbox/connector";
import { deleteAccount } from "@/server/account-deletion";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { describeActivity } from "@/server/activity";
import { adminOverview } from "@/server/admin";
import {
  applyCheckoutCompleted,
  applySubscription,
  handleStripeWebhook,
  setStripeForTests,
} from "@/server/billing";
import { planLookupKey } from "@/server/billing-rules";
import {
  errorCodeOf,
  isReferralCode,
  isUniqueViolation,
  newReferralCode,
  PUBLIC_WEBMAIL_DOMAINS,
  referralLink,
  referralRefusal,
  referralReward,
  referralsVisible,
  referredEmailHash,
  setReferralConfigForTests,
} from "@/server/referral-rules";
import {
  creditReferralOnActive,
  creditReferralSafely,
  runReferralRewards,
  ensureReferralCode,
  referralLinkFor,
  workspaceByReferralCode,
} from "@/server/referrals";
import { inviteFromWaitlist, joinWaitlist, waitlistInput } from "@/server/waitlist";
import { applyAdminMove } from "@/server/workspace-lifecycle";
import { createTestDb } from "../support/db";
import { FakeStripe } from "../support/fake-stripe";

const NOW = new Date("2026-10-12T14:00:00Z");
const ON = { FEATURE_REFERRALS: "1" };
const SECRET = "whsec_test";

// --- Fake Stripe (tests/support/fake-stripe.ts): settling a referral never calls it --------

let fake: FakeStripe;

/** Stripe calls other than the account-deletion cancel (which isn't about referrals). */
/**
 * Stripe calls made for referrals. Not counted: the account deletion's cancel, and the webhook's
 * own fresh read of the subscription it was told about (§1.9: every subscription event, with
 * referrals on or off).
 */
const stripeCalls = () =>
  fake.calls.filter(
    (c) => c.method !== "subscriptions.cancel" && c.method !== "subscriptions.retrieve",
  ).length;

// --- Database helpers -----------------------------------------------------------------------

let database: Database;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AUTH_SECRET = "test-secret";
  process.env.APP_URL = "https://app.example";
  delete process.env.FEATURE_REFERRALS;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_SECRET_KEY;
  database = await createTestDb();
  fake = new FakeStripe({ now: NOW, webhookSecret: SECRET });
  setStripeForTests(fake.client);
  await database
    .insert(appSettings)
    .values({ key: "stripe_webhook_secret", value: encryptSecret(SECRET) });
});

afterEach(() => {
  setStripeForTests(undefined);
  setReferralConfigForTests(undefined);
  delete process.env.FEATURE_REFERRALS;
  delete process.env.STRIPE_SECRET_KEY;
  vi.restoreAllMocks();
});

function turnOn(reward: "free_month_one_plan_up" | null = "free_month_one_plan_up") {
  process.env.FEATURE_REFERRALS = "1";
  setReferralConfigForTests({ reward });
}

async function set(id: string, values: Partial<Workspace>) {
  await database.update(workspaces).set(values).where(eq(workspaces.id, id));
}

async function load(id: string) {
  const [w] = await database.select().from(workspaces).where(eq(workspaces.id, id));
  return w!;
}

/** A paying, active referrer with a Stripe customer. */
async function referrer(email = "rosa@gmail.com", over: Partial<Workspace> = {}) {
  const { workspace } = await ensureUserAndWorkspace({ email });
  await set(workspace.id, {
    businessName: "Rosa Plumbing",
    status: "active",
    plan: "crew",
    setupPaidAt: NOW,
    setupPaidVia: "stripe",
    setupCallCompletedAt: NOW,
    stripeCustomerId: "cus_ref",
    ...over,
  });
  return load(workspace.id);
}

/** The waitlist form's required fields (PR #9). */
const appFields = { trade: "carpentry", teamSize: "Just me" } as const;

/** Waitlist with the referral link → Davi's invite → first sign-in. */
async function referredViaLink(code: string, email = "mike@yahoo.com") {
  await joinWaitlist(
    waitlistInput.parse({ ...appFields, name: "Mike", email, referralCode: code }),
  );
  expect(await inviteFromWaitlist(email)).toBe("invited");
  const { workspace, user } = await ensureUserAndWorkspace({ email });
  await set(workspace.id, {
    status: "evaluating",
    evaluationStartedAt: NOW,
    evaluationEndsAt: new Date(NOW.getTime() + 3 * 86_400_000),
  });
  return { workspace: await load(workspace.id), user };
}

const paidSession = (workspaceId: string, over: Record<string, unknown> = {}) =>
  ({
    id: "cs_1",
    mode: "subscription",
    payment_status: "paid",
    customer: "cus_new",
    subscription: "sub_new",
    client_reference_id: workspaceId,
    metadata: { workspaceId, plan: "solo", includesSetup: "1" },
    ...over,
  }) as unknown as Stripe.Checkout.Session;

const subscription = (workspaceId: string, status: string) =>
  ({
    id: "sub_new",
    status,
    metadata: { workspaceId },
    items: { data: [{ price: { lookup_key: planLookupKey("solo") } }] },
  }) as unknown as Stripe.Subscription;

/** The full happy path: pay (setup_paid, nothing earned yet), then the setup call (→ active). */
async function payAndFinishSetup(referredId: string) {
  await applyCheckoutCompleted(paidSession(referredId), NOW);
  expect((await load(referredId)).status).toBe("setup_paid");
  return applyAdminMove(referredId, "mark_setup_call_done", NOW);
}

const rows = () => database.select().from(referralCredits);
const shape = async () =>
  (await rows()).map((r) => [r.side, r.status, r.reward, r.skipReason, r.amountCents]);
const earnedLogs = () =>
  database.select().from(activityLog).where(eq(activityLog.action, "referral_reward_earned"));

// --- Pure rules -----------------------------------------------------------------------------

describe("referral rules", () => {
  it("the committed config gives the referrer a free month one plan up (Davi, 2026-10-15)", () => {
    expect(REFERRAL_REWARD).toBe("free_month_one_plan_up");
    expect(referralReward(ON)).toEqual({ kind: "free_month_one_plan_up" });
    expect(referralsVisible(ON)).toBe(true);
  });

  it("gives nothing with the switch off, or with no reward configured", () => {
    expect(referralReward({})).toBeNull();
    expect(referralReward({ FEATURE_REFERRALS: "yes" })).toBeNull();
    expect(referralsVisible({})).toBe(false);
    expect(referralReward(ON, null)).toBeNull();
  });

  it("the test seam feeds the default and resets", () => {
    setReferralConfigForTests({ reward: null });
    expect(referralReward(ON)).toBeNull();
    setReferralConfigForTests(undefined);
    expect(referralReward(ON)).toEqual({ kind: "free_month_one_plan_up" });
  });

  it("codes are 12 random base64url characters", () => {
    const codes = new Set(Array.from({ length: 200 }, () => newReferralCode()));
    expect(codes.size).toBe(200);
    for (const c of codes) {
      expect(c).toMatch(/^[A-Za-z0-9_-]{12}$/);
      expect(isReferralCode(c)).toBe(true);
    }
    for (const bad of ["", "short", "a".repeat(13), "abc def ghij", "abc@def.com1", null, 12]) {
      expect(isReferralCode(bad)).toBe(false);
    }
  });

  it("refuses self and same-business-domain referrals, allows public webmail", () => {
    const p = (workspaceId: string, ownerEmail: string) => ({ workspaceId, ownerEmail });
    expect(referralRefusal(p("w1", "a@shop.com"), p("w1", "b@other.com"))).toBe("self");
    expect(referralRefusal(p("w1", "a@shop.com"), p("w2", " A@Shop.com "))).toBe("self");
    expect(referralRefusal(p("w1", "a@shop.com"), p("w2", "b@shop.com"))).toBe("same_domain");
    expect(referralRefusal(p("w1", "a@SHOP.com"), p("w2", "b@shop.COM"))).toBe("same_domain");
    for (const d of ["gmail.com", "yahoo.com", "outlook.com", "icloud.com"]) {
      expect(PUBLIC_WEBMAIL_DOMAINS.has(d)).toBe(true);
      expect(referralRefusal(p("w1", `a@${d}`), p("w2", `b@${d}`))).toBeNull();
    }
    expect(referralRefusal(p("w1", "a@shop.com"), p("w2", "b@plumb.com"))).toBeNull();
  });

  it("the durable key is a salted hash, never the address", () => {
    const h = referredEmailHash(" Mike@Yahoo.com ", "s1");
    expect(h).toBe(referredEmailHash("mike@yahoo.com", "s1"));
    expect(h).not.toBe(referredEmailHash("mike@yahoo.com", "s2"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("mike");
  });

  it("stores Stripe error codes only", () => {
    expect(errorCodeOf({ code: "resource_missing" })).toBe("resource_missing");
    expect(
      errorCodeOf(Object.assign(new TypeError("No such customer: cus_1"), { code: "cus_1 x" })),
    ).toBe("TypeError");
    expect(errorCodeOf("nope")).toBe("unknown");
  });

  it("still describes the old balance credit in plain words (history)", () => {
    expect(describeActivity("referral_credit_applied", { side: "referrer" }, null)).toBe(
      "A referral credit was added to your account",
    );
  });
});

// --- Migration ------------------------------------------------------------------------------

describe("migration 0026 (referrals)", () => {
  const sqlText = readFileSync(join("drizzle", "0026_referrals.sql"), "utf8");

  it("is additive: new table, nullable columns, indexes and foreign keys only", () => {
    expect(sqlText).not.toMatch(/\bDROP\b|\bRENAME\b|SET NOT NULL|ALTER COLUMN/i);
    for (const col of [
      `ALTER TABLE "invites" ADD COLUMN "referred_by_workspace_id" uuid;`,
      `ALTER TABLE "waitlist" ADD COLUMN "referral_code" text;`,
      `ALTER TABLE "workspaces" ADD COLUMN "referral_code" text;`,
      `ALTER TABLE "workspaces" ADD COLUMN "referred_by_workspace_id" uuid;`,
    ])
      expect(sqlText).toContain(col);
    expect(sqlText).toContain(`CREATE TABLE "referral_credits"`);
  });

  it("comes right after 0025 in the journal", () => {
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as {
      entries: { tag: string }[];
    };
    const i = journal.entries.findIndex((e) => e.tag === "0026_referrals");
    expect(journal.entries[i - 1]!.tag).toBe("0025_m8_alerts_monthly");
  });
});

// --- Codes ----------------------------------------------------------------------------------

describe("referral codes", () => {
  it("are made once, stay the same, differ per workspace and resolve back", async () => {
    const a = await referrer();
    const { workspace: b } = await ensureUserAndWorkspace({ email: "b@gmail.com" });
    const codeA = await ensureReferralCode(a.id);
    expect(await ensureReferralCode(a.id)).toBe(codeA);
    const codeB = await ensureReferralCode(b.id);
    expect(codeB).not.toBe(codeA);
    expect(isReferralCode(codeA)).toBe(true);
    expect(await workspaceByReferralCode(codeA)).toBe(a.id);
    expect(await workspaceByReferralCode("unknownCode1")).toBeNull();
    expect(await workspaceByReferralCode("not a code")).toBeNull();
    // The link the billing page shows carries the code only: no email, no workspace id.
    const link = await referralLinkFor(a.id);
    expect(link).toBe(referralLink(codeA));
    expect(link).toMatch(/^https:\/\/app\.example\/\?ref=[A-Za-z0-9_-]{12}$/);
    expect(link).not.toContain("@");
    expect(link).not.toContain(a.id);
    expect(link).not.toContain("rosa");
  });

  it("a real clash on the code is a unique violation; other errors are not", async () => {
    const a = await referrer();
    const { workspace: b } = await ensureUserAndWorkspace({ email: "b@gmail.com" });
    const codeA = await ensureReferralCode(a.id);
    const clash = await database
      .update(workspaces)
      .set({ referralCode: codeA })
      .where(eq(workspaces.id, b.id))
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(clash).not.toBeNull();
    expect(isUniqueViolation(clash)).toBe(true);
    expect(isUniqueViolation(new Error("connection lost"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });

  /** The database, except updating workspaces throws `make()` the first `failures` times. */
  function workspaceUpdatesThrow(make: () => unknown, failures = Number.POSITIVE_INFINITY) {
    const seen = { updates: 0 };
    let left = failures;
    const proxy = new Proxy(database, {
      get(target, prop, receiver) {
        if (prop === "update") {
          return (table: unknown) => {
            if (table === workspaces) {
              seen.updates++;
              if (left > 0) {
                left--;
                throw make();
              }
            }
            return target.update(table as typeof workspaces);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Database;
    return { proxy, seen };
  }

  it("retries a code clash, but rethrows anything else at once", async () => {
    const a = await referrer();
    // Drizzle wraps the driver's error; the 23505 is on its cause.
    const clash = workspaceUpdatesThrow(
      () => Object.assign(new Error("Failed query"), { cause: { code: "23505" } }),
      1,
    );
    setDbForTests(clash.proxy);
    expect(isReferralCode(await ensureReferralCode(a.id))).toBe(true);
    expect(clash.seen.updates).toBe(2);

    const { workspace: b } = await ensureUserAndWorkspace({ email: "b@gmail.com" });
    const down = workspaceUpdatesThrow(() => new Error("connection lost"));
    setDbForTests(down.proxy);
    await expect(ensureReferralCode(b.id)).rejects.toThrow("connection lost");
    expect(down.seen.updates).toBe(1);
    setDbForTests(database);
  });

  it("Plan & billing hides the link instead of failing when the code can't be made", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { workspace } = await ensureUserAndWorkspace({ email: "b@gmail.com" });
    setDbForTests(
      workspaceUpdatesThrow(() => new Error("cus_x b@gmail.com connection lost")).proxy,
    );
    expect(await referralLinkFor(workspace.id)).toBeNull();
    setDbForTests(database);
    expect(errors.mock.calls).toEqual([
      ["referral_code_failed", { workspaceId: workspace.id, error: "Error" }],
    ]);
  });
});

// --- Gates ----------------------------------------------------------------------------------

describe("GATE: switched off, or no reward configured", () => {
  it("off: the waitlist keeps no code, nothing is carried, admin shows no referrer (A8)", async () => {
    const ref = await referrer();
    const code = await ensureReferralCode(ref.id);
    // A row saved with a code earlier (or seeded) still carries nothing while off.
    await database
      .insert(waitlist)
      .values({ email: "old@yahoo.com", name: "Old", referralCode: code });
    await joinWaitlist(
      waitlistInput.parse({
        ...appFields,
        name: "Mike",
        email: "mike@yahoo.com",
        referralCode: code,
      }),
    );
    const [joined] = await database
      .select()
      .from(waitlist)
      .where(eq(waitlist.email, "mike@yahoo.com"));
    expect(joined?.referralCode).toBeNull();

    for (const email of ["old@yahoo.com", "mike@yahoo.com"]) {
      await inviteFromWaitlist(email);
      const [inv] = await database.select().from(invites).where(eq(invites.email, email));
      expect(inv?.referredByWorkspaceId).toBeNull();
      const { workspace } = await ensureUserAndWorkspace({ email });
      expect(workspace.referredByWorkspaceId).toBeNull();
    }
    // Linked directly (say, while it was on), with a free month still waiting for the referrer.
    const { workspace: linked } = await ensureUserAndWorkspace({ email: "linked@yahoo.com" });
    await set(linked.id, { referredByWorkspaceId: ref.id });
    await database.insert(referralCredits).values({
      referredWorkspaceId: linked.id,
      referredEmailSha256: "y".repeat(64),
      beneficiaryWorkspaceId: ref.id,
      side: "referrer",
      amountCents: 0,
      reward: "free_month_up",
    });
    const byId = async () =>
      new Map((await adminOverview(NOW)).map((r) => [r.workspaceId, r] as const));
    const off = await byId();
    expect([...off.values()].every((r) => r.referredByName === null)).toBe(true);
    // An earned month never disappears from /admin when the switch is off.
    expect(off.get(ref.id)!.referralCredits).toEqual({
      waiting: 1,
      failed: 0,
      lastErrorCode: null,
    });
    expect(off.get(linked.id)!.referralCredits).toEqual({
      waiting: 0,
      failed: 0,
      lastErrorCode: null,
    });

    turnOn();
    const on = await byId();
    expect(on.get(linked.id)!.referredByName).toBe("Rosa Plumbing");
    expect(stripeCalls()).toBe(0);
  });

  it("off: an invite that already carries a referral isn't carried, but is used up (A5)", async () => {
    const ref = await referrer();
    await database
      .insert(invites)
      .values({ email: "mike@yahoo.com", referredByWorkspaceId: ref.id });
    const { workspace } = await ensureUserAndWorkspace({ email: "mike@yahoo.com" });
    expect(workspace.referredByWorkspaceId).toBeNull();
    const [inv] = await database.select().from(invites).where(eq(invites.email, "mike@yahoo.com"));
    expect(inv?.referredByWorkspaceId).toBeNull();
    // Turning it on afterwards links nothing on a later sign-in.
    turnOn();
    const { workspace: again } = await ensureUserAndWorkspace({ email: "mike@yahoo.com" });
    expect(again.id).toBe(workspace.id);
    expect(again.referredByWorkspaceId).toBeNull();
  });

  it("off at first sign-in: never given later, even after delete + on + sign up again (A5/A9)", async () => {
    turnOn();
    const ref = await referrer();
    const code = await ensureReferralCode(ref.id);
    await joinWaitlist(
      waitlistInput.parse({
        ...appFields,
        name: "Mike",
        email: "mike@yahoo.com",
        referralCode: code,
      }),
    );
    expect(await inviteFromWaitlist("mike@yahoo.com")).toBe("invited");
    const invite = async () =>
      (await database.select().from(invites).where(eq(invites.email, "mike@yahoo.com")))[0];
    expect((await invite())?.referredByWorkspaceId).toBe(ref.id);

    // Switched off before Mike's first sign-in: the invite is used up, his workspace isn't linked.
    delete process.env.FEATURE_REFERRALS;
    const { workspace, user } = await ensureUserAndWorkspace({ email: "mike@yahoo.com" });
    expect(workspace.referredByWorkspaceId).toBeNull();
    expect((await invite())?.referredByWorkspaceId).toBeNull();
    const startEvaluation = (id: string) =>
      set(id, {
        status: "evaluating",
        evaluationStartedAt: NOW,
        evaluationEndsAt: new Date(NOW.getTime() + 3 * 86_400_000),
      });
    await startEvaluation(workspace.id);
    await payAndFinishSetup(workspace.id);
    expect((await load(workspace.id)).status).toBe("active");

    const connector = { revoke: async () => {} } as unknown as MailboxConnector;
    await deleteAccount(user.id, connector);

    // On again, Mike signs up again and goes active: nothing links him, nothing is earned.
    turnOn();
    const { workspace: again } = await ensureUserAndWorkspace({ email: "mike@yahoo.com" });
    expect(again.id).not.toBe(workspace.id);
    expect(again.referredByWorkspaceId).toBeNull();
    await startEvaluation(again.id);
    await payAndFinishSetup(again.id);
    expect((await load(again.id)).status).toBe("active");
    expect(await creditReferralOnActive(again.id, NOW)).toBe("skipped");
    await runReferralRewards(NOW);
    await applySubscription(subscription(again.id, "active"), NOW);

    expect(stripeCalls()).toBe(0);
    expect(await rows()).toHaveLength(0);
  });

  it("off: settling is skipped ('off'), Stripe is never called, and the sweep does nothing", async () => {
    const ref = await referrer();
    const { workspace } = await ensureUserAndWorkspace({ email: "mike@yahoo.com" });
    await set(workspace.id, {
      referredByWorkspaceId: ref.id,
      status: "active",
      setupPaidVia: "stripe",
      stripeCustomerId: "cus_new",
    });
    expect(await creditReferralOnActive(workspace.id, NOW)).toBe("skipped");
    // A waiting row from an earlier "on" period isn't touched either.
    await database.insert(referralCredits).values({
      referredWorkspaceId: workspace.id,
      referredEmailSha256: "x".repeat(64),
      beneficiaryWorkspaceId: ref.id,
      side: "referrer",
      amountCents: 0,
      reward: "free_month_up",
    });
    expect(await runReferralRewards(NOW)).toMatchObject({ settled: 0 });
    expect(stripeCalls()).toBe(0);
    expect((await shape()).sort()).toEqual([
      ["referrer", "pending", "free_month_up", null, 0],
      ["referrer", "skipped", "free_month_up", "off", 0],
    ]);
    expect(await earnedLogs()).toHaveLength(0);
  });

  it("on with no reward configured: settled as skipped ('off'), nothing earned", async () => {
    turnOn(null);
    expect(referralReward()).toBeNull();
    const ref = await referrer();
    const { workspace } = await ensureUserAndWorkspace({ email: "mike@yahoo.com" });
    await set(workspace.id, {
      referredByWorkspaceId: ref.id,
      status: "active",
      setupPaidVia: "stripe",
      stripeCustomerId: "cus_new",
    });
    expect(await creditReferralOnActive(workspace.id, NOW)).toBe("skipped");
    expect(await runReferralRewards(NOW)).toMatchObject({ settled: 0 });
    expect(await shape()).toEqual([["referrer", "skipped", "free_month_up", "off", 0]]);
    expect(stripeCalls()).toBe(0);
  });
});

// --- The full chain -------------------------------------------------------------------------

describe("referral free month (switched on)", () => {
  it("carries the link → waitlist → invite → workspace, using up the invite (A5)", async () => {
    turnOn();
    const ref = await referrer();
    const code = await ensureReferralCode(ref.id);
    const { workspace } = await referredViaLink(code);
    expect(workspace.referredByWorkspaceId).toBe(ref.id);
    const [w] = await database.select().from(waitlist);
    expect(w?.referralCode).toBe(code);
    const [inv] = await database.select().from(invites);
    expect(inv?.referredByWorkspaceId).toBeNull();
    // A later sign-in never overwrites it.
    await set(workspace.id, { referredByWorkspaceId: null });
    await database.update(invites).set({ referredByWorkspaceId: ref.id });
    await ensureUserAndWorkspace({ email: "mike@yahoo.com" });
    expect((await load(workspace.id)).referredByWorkspaceId).toBeNull();
  });

  it("ignores unknown and malformed codes", async () => {
    turnOn();
    await referrer();
    await referredViaLink("unknownCode1", "a@yahoo.com");
    await joinWaitlist(
      waitlistInput.parse({
        ...appFields,
        name: "B",
        email: "b@yahoo.com",
        referralCode: "<script>bad",
      }),
    );
    const [b] = await database.select().from(waitlist).where(eq(waitlist.email, "b@yahoo.com"));
    expect(b?.referralCode).toBeNull();
    await inviteFromWaitlist("b@yahoo.com");
    for (const email of ["a@yahoo.com", "b@yahoo.com"]) {
      const { workspace } = await ensureUserAndWorkspace({ email });
      expect(workspace.referredByWorkspaceId).toBeNull();
    }
  });

  it("earns only once active: nothing at setup_paid, then one waiting free month for the referrer", async () => {
    turnOn();
    const ref = await referrer();
    const { workspace } = await referredViaLink(await ensureReferralCode(ref.id));
    await applyCheckoutCompleted(paidSession(workspace.id), NOW);
    expect(await rows()).toHaveLength(0);

    expect(await applyAdminMove(workspace.id, "mark_setup_call_done", NOW)).toBe("active");
    expect(await shape()).toEqual([["referrer", "pending", "free_month_up", null, 0]]);
    const [row] = await rows();
    expect(row!.beneficiaryWorkspaceId).toBe(ref.id);
    // Settling books nothing in Stripe: that is the reward engine's job.
    expect(stripeCalls()).toBe(0);
    const logs = await earnedLogs();
    expect(logs.map((l) => [l.workspaceId, l.actor, l.detail])).toEqual([
      [ref.id, "squared_away", {}],
    ]);
  });

  it.each([
    ["sk_test_x", "test"],
    ["rk_live_x", "live"],
    [undefined, null],
  ] as const)("tags the earned month with the key's Stripe mode (%s → %s)", async (key, mode) => {
    turnOn();
    if (key) process.env.STRIPE_SECRET_KEY = key;
    const ref = await referrer();
    const { workspace } = await referredViaLink(await ensureReferralCode(ref.id));
    await payAndFinishSetup(workspace.id);
    expect((await rows()).map((r) => r.stripeMode)).toEqual([mode]);
  });

  it("is earned once ever: pause/resume, re-checkout and a replayed webhook add nothing", async () => {
    turnOn();
    const ref = await referrer();
    const { workspace } = await referredViaLink(await ensureReferralCode(ref.id));
    await payAndFinishSetup(workspace.id);
    expect(await rows()).toHaveLength(1);

    await applyAdminMove(workspace.id, "pause", NOW);
    expect(await applyAdminMove(workspace.id, "resume", NOW)).toBe("active");

    await applySubscription(subscription(workspace.id, "canceled"), NOW);
    expect((await load(workspace.id)).status).toBe("canceled");
    const again = paidSession(workspace.id, {
      metadata: { workspaceId: workspace.id, plan: "solo", includesSetup: "0" },
    });
    await applyCheckoutCompleted(again, NOW);
    expect((await load(workspace.id)).status).toBe("active");

    const body = JSON.stringify({
      id: "evt_1",
      type: "customer.subscription.updated",
      data: { object: subscription(workspace.id, "active") },
    });
    expect((await handleStripeWebhook(body, "good")).status).toBe(200);
    expect((await handleStripeWebhook(body, "good")).body).toBe("Already handled.");
    await runReferralRewards(new Date(NOW.getTime() + 86_400_000));

    expect(await rows()).toHaveLength(1);
    expect(await earnedLogs()).toHaveLength(1);
  });

  it("a referral that went active while off is settled as skipped and never given later (A9)", async () => {
    turnOn();
    const ref = await referrer();
    const { workspace } = await referredViaLink(await ensureReferralCode(ref.id));
    delete process.env.FEATURE_REFERRALS;
    await payAndFinishSetup(workspace.id);
    expect((await rows()).map((r) => [r.status, r.skipReason])).toEqual([["skipped", "off"]]);

    turnOn();
    await runReferralRewards(NOW);
    await applySubscription(subscription(workspace.id, "active"), NOW);
    expect((await rows()).map((r) => [r.status, r.skipReason])).toEqual([["skipped", "off"]]);
    expect(await earnedLogs()).toHaveLength(0);
  });

  it("refuses same-business-domain referrals at sign-up and at settle time", async () => {
    turnOn();
    const ref = await referrer("a@shop.com");
    const code = await ensureReferralCode(ref.id);
    const { workspace } = await referredViaLink(code, "b@shop.com");
    expect(workspace.referredByWorkspaceId).toBeNull();

    // Linked anyway (say, by an older path): the settle check refuses it too, and records
    // the decision once so the sweep never looks at it again (A9).
    await set(workspace.id, { referredByWorkspaceId: ref.id });
    await payAndFinishSetup(workspace.id);
    expect(await creditReferralOnActive(workspace.id, NOW)).toBe("skipped");
    const settled = await rows();
    expect(await shape()).toEqual([["referrer", "skipped", "free_month_up", "same_domain", 0]]);
    expect(stripeCalls()).toBe(0);

    const counted = { select: 0, transaction: 0 };
    setDbForTests(
      new Proxy(database, {
        get(target, prop, receiver) {
          if (prop === "select" || prop === "transaction") counted[prop]++;
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      }) as Database,
    );
    expect(await runReferralRewards(NOW)).toMatchObject({ settled: 0 });
    setDbForTests(database);
    // Only the sweep's own lookup (unsettled accounts and its NOT EXISTS subquery): no owner
    // lookups, no settlement attempt.
    expect(counted).toEqual({ select: 2, transaction: 0 });
    expect(await rows()).toEqual(settled);
  });

  it("refuses self-referral (same workspace)", async () => {
    turnOn();
    const ref = await referrer();
    await set(ref.id, { referredByWorkspaceId: ref.id });
    expect(await creditReferralOnActive(ref.id, NOW)).toBe("skipped");
    expect((await rows()).map((r) => [r.status, r.skipReason])).toEqual([["skipped", "self"]]);
    expect(await runReferralRewards(NOW)).toMatchObject({ settled: 0 });
    expect(await rows()).toHaveLength(1);
    expect(await earnedLogs()).toHaveLength(0);
  });

  it("a house-account referrer (Davi's own) has no bill to make free: skipped ('house')", async () => {
    turnOn();
    const ref = await referrer("rosa@gmail.com", { setupPaidVia: "house", stripeCustomerId: null });
    const { workspace } = await referredViaLink(await ensureReferralCode(ref.id));
    await payAndFinishSetup(workspace.id);
    expect((await rows()).map((r) => [r.status, r.skipReason])).toEqual([["skipped", "house"]]);
    expect(await earnedLogs()).toHaveLength(0);
  });

  it.each(["gmail.com", "yahoo.com", "outlook.com", "icloud.com"])(
    "two owners on %s can refer each other",
    async (domain) => {
      turnOn();
      const ref = await referrer(`rosa@${domain}`);
      const { workspace } = await referredViaLink(
        await ensureReferralCode(ref.id),
        `mike@${domain}`,
      );
      expect(workspace.referredByWorkspaceId).toBe(ref.id);
      await payAndFinishSetup(workspace.id);
      expect((await rows()).map((r) => r.status)).toEqual(["pending"]);
    },
  );

  it.each([null, "house"] as const)(
    "needs a real Stripe setup payment: setup paid via %s never earns anything (A27)",
    async (via) => {
      turnOn();
      const ref = await referrer();
      const { workspace } = await referredViaLink(await ensureReferralCode(ref.id));
      await set(workspace.id, {
        status: "setup_paid",
        setupPaidAt: NOW,
        setupPaidVia: via,
        stripeCustomerId: "cus_new",
      });
      expect(await applyAdminMove(workspace.id, "mark_setup_call_done", NOW)).toBe("active");
      expect(await runReferralRewards(NOW)).toMatchObject({ settled: 0 });
      expect(await creditReferralOnActive(workspace.id, NOW)).toBe("skipped");
      expect(await rows()).toHaveLength(0);
      expect(stripeCalls()).toBe(0);
    },
  );

  it.each(["setup_paid", "paused", "past_due"] as const)(
    "settles nothing while the referred account is %s, even paid through Stripe",
    async (status) => {
      turnOn();
      const ref = await referrer();
      const { workspace } = await referredViaLink(await ensureReferralCode(ref.id));
      await set(workspace.id, {
        status,
        setupPaidAt: NOW,
        setupPaidVia: "stripe",
        setupCallCompletedAt: NOW,
        stripeCustomerId: "cus_new",
        plan: "solo",
      });
      expect((await load(workspace.id)).referredByWorkspaceId).toBe(ref.id);
      expect(await creditReferralOnActive(workspace.id, NOW)).toBe("skipped");
      expect(await creditReferralSafely(workspace.id, NOW)).toBe("skipped");
      expect(await rows()).toHaveLength(0);
      expect(stripeCalls()).toBe(0);
    },
  );

  it("is earned even while the referrer has no plan yet (it waits for one)", async () => {
    turnOn();
    const ref = await referrer("rosa@gmail.com", {
      status: "evaluating",
      plan: null,
      setupPaidVia: null,
      stripeCustomerId: null,
    });
    const { workspace } = await referredViaLink(await ensureReferralCode(ref.id));
    await payAndFinishSetup(workspace.id);
    expect((await rows()).map((r) => r.status)).toEqual(["pending"]);
  });

  /** The database, except settling a referral (its transaction) throws `failures` times. */
  function settlementThrows(failures = Number.POSITIVE_INFINITY) {
    let left = failures;
    return new Proxy(database, {
      get(target, prop, receiver) {
        // Only the settlement's own transaction (the webhook's status write has its own).
        if (
          prop === "transaction" &&
          left > 0 &&
          new Error().stack?.includes("creditReferralOnActive")
        ) {
          return () => {
            left--;
            // A message carrying ids and an address: none of it may reach the log.
            throw new Error("cus_ref mike@yahoo.com connection lost");
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Database;
  }

  function expectSettleFailedLogs(errors: { mock: { calls: unknown[][] } }, ids: string[]) {
    const settle = errors.mock.calls.filter(([event]) => event === "referral_settle_failed");
    expect(
      settle.map(([, d]) => (d as { referredWorkspaceId: string }).referredWorkspaceId),
    ).toEqual(ids);
    for (const call of errors.mock.calls) {
      expect(call).toHaveLength(2);
      expect(JSON.stringify(call)).not.toMatch(/cus_|@|connection lost/);
    }
    for (const [, d] of settle)
      expect(d).toEqual({ referredWorkspaceId: expect.any(String), error: "Error" });
  }

  it("the settlement itself failing never fails the admin move (A3 log)", async () => {
    turnOn();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const ref = await referrer();
    const { workspace } = await referredViaLink(await ensureReferralCode(ref.id));
    await applyCheckoutCompleted(paidSession(workspace.id), NOW);

    setDbForTests(settlementThrows());
    expect(await applyAdminMove(workspace.id, "mark_setup_call_done", NOW)).toBe("active");
    setDbForTests(database);
    expect((await load(workspace.id)).status).toBe("active");
    expect(await rows()).toHaveLength(0);
    expectSettleFailedLogs(errors, [workspace.id]);

    // The sweep settles it later.
    expect(await runReferralRewards(NOW)).toMatchObject({ settled: 1 });
    expect((await rows()).map((r) => r.status)).toEqual(["pending"]);
  });

  it("the settlement itself failing never fails the Stripe webhook (no replay)", async () => {
    turnOn();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const ref = await referrer();
    const { workspace } = await referredViaLink(await ensureReferralCode(ref.id));
    // Setup call already done, so paying moves it straight to active.
    await set(workspace.id, { status: "canceled", setupCallCompletedAt: NOW });

    setDbForTests(settlementThrows());
    const body = JSON.stringify({
      id: "evt_settle",
      type: "checkout.session.completed",
      data: { object: paidSession(workspace.id) },
    });
    expect(await handleStripeWebhook(body, "good")).toEqual({ status: 200, body: "ok" });
    expect(await applySubscription(subscription(workspace.id, "active"), NOW)).toBe("applied");
    await set(workspace.id, { status: "canceled" });
    expect(
      await applyCheckoutCompleted(
        paidSession(workspace.id, {
          metadata: { workspaceId: workspace.id, plan: "solo", includesSetup: "0" },
        }),
        NOW,
      ),
    ).toBe("applied");
    setDbForTests(database);

    expect((await load(workspace.id)).status).toBe("active");
    // The event was kept as handled: Stripe won't replay it.
    expect((await handleStripeWebhook(body, "good")).body).toBe("Already handled.");
    expect(await rows()).toHaveLength(0);
    expectSettleFailedLogs(errors, [workspace.id, workspace.id, workspace.id]);
  });

  it("one account whose settlement throws never stops the sweep for the next (A29)", async () => {
    turnOn();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const ref = await referrer();
    const code = await ensureReferralCode(ref.id);
    const ids: string[] = [];
    for (const [email, customer] of [
      ["mike@yahoo.com", "cus_a"],
      ["dana@yahoo.com", "cus_b"],
    ] as const) {
      const { workspace } = await referredViaLink(code, email);
      await set(workspace.id, {
        status: "active",
        setupPaidAt: NOW,
        setupPaidVia: "stripe",
        setupCallCompletedAt: NOW,
        stripeCustomerId: customer,
      });
      ids.push(workspace.id);
    }

    setDbForTests(settlementThrows(1));
    expect(await runReferralRewards(NOW)).toMatchObject({ settled: 1 });
    setDbForTests(database);
    const settledFor = new Set((await rows()).map((r) => r.referredWorkspaceId));
    expect(settledFor.size).toBe(1);
    const missed = ids.find((id) => !settledFor.has(id))!;
    expectSettleFailedLogs(errors, [missed]);

    // Next run picks up the one that failed. Two referrals: two waiting free months.
    expect(await runReferralRewards(NOW)).toMatchObject({ settled: 1 });
    expect(new Set((await rows()).map((r) => r.referredWorkspaceId))).toEqual(new Set(ids));
    expect((await rows()).map((r) => r.status)).toEqual(["pending", "pending"]);
  });

  it("/admin shows the most recent Stripe refusal's code, not an alphabetical max", async () => {
    const ref = await referrer();
    const base = {
      beneficiaryWorkspaceId: ref.id,
      side: "referrer" as const,
      amountCents: 0,
      status: "failed" as const,
    };
    await database.insert(referralCredits).values([
      { ...base, referredEmailSha256: "a".repeat(64), lastErrorCode: "zzz_old", createdAt: NOW },
      {
        ...base,
        referredEmailSha256: "b".repeat(64),
        lastErrorCode: "resource_missing",
        createdAt: new Date(NOW.getTime() + 60_000),
      },
      { ...base, referredEmailSha256: "c".repeat(64), status: "applied", lastErrorCode: "zzzz" },
    ]);
    const row = (await adminOverview(NOW)).find((r) => r.workspaceId === ref.id)!;
    expect(row.referralCredits).toEqual({
      waiting: 0,
      failed: 2,
      lastErrorCode: "resource_missing",
    });
  });

  it("the sweep settles an active referred account whose move didn't reach the settle", async () => {
    turnOn();
    const ref = await referrer();
    const { workspace } = await referredViaLink(await ensureReferralCode(ref.id));
    await set(workspace.id, {
      status: "active",
      setupPaidAt: NOW,
      setupPaidVia: "stripe",
      setupCallCompletedAt: NOW,
      stripeCustomerId: "cus_new",
    });
    expect(await runReferralRewards(NOW)).toMatchObject({ settled: 1 });
    expect(await runReferralRewards(NOW)).toMatchObject({ settled: 0 });
    expect(await rows()).toHaveLength(1);
    expect(stripeCalls()).toBe(0);
  });

  it("survives account deletion: the same email signing up again earns nothing (A5)", async () => {
    turnOn();
    const ref = await referrer();
    const { workspace, user } = await referredViaLink(await ensureReferralCode(ref.id));
    await payAndFinishSetup(workspace.id);
    expect(await rows()).toHaveLength(1);

    const connector = { revoke: async () => {} } as unknown as MailboxConnector;
    await deleteAccount(user.id, connector);
    const kept = await rows();
    expect(kept).toHaveLength(1);
    expect(kept.every((r) => r.referredWorkspaceId === null)).toBe(true);

    // Deleting the account removed the invite: coming back takes a new one (S3).
    expect(
      await database.select().from(invites).where(eq(invites.email, "mike@yahoo.com")),
    ).toHaveLength(0);
    // Same email back on a plain new invite: nothing links them...
    await database.insert(invites).values({ email: "mike@yahoo.com" });
    const { workspace: again } = await ensureUserAndWorkspace({ email: "mike@yahoo.com" });
    expect(again.referredByWorkspaceId).toBeNull();
    // ...and even if something did, the email key says it was already given.
    await set(again.id, { referredByWorkspaceId: ref.id });
    await payAndFinishSetup(again.id);
    await runReferralRewards(NOW);
    expect(await rows()).toHaveLength(1);
    expect(await earnedLogs()).toHaveLength(1);
    // The used-up link is dropped, so the 15-minute sweep doesn't revisit it forever.
    expect((await load(again.id)).referredByWorkspaceId).toBeNull();
  });
});

// --- Privacy --------------------------------------------------------------------------------

describe("GUARDRAIL: referral data stays content-free", () => {
  it("activity detail is empty; admin shows the referrer's business name only", async () => {
    turnOn();
    const ref = await referrer();
    const { workspace } = await referredViaLink(await ensureReferralCode(ref.id));
    await payAndFinishSetup(workspace.id);

    const logs = await earnedLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.detail).toEqual({});
    expect(logs[0]!.workspaceId).toBe(ref.id);

    const row = (await adminOverview(NOW)).find((r) => r.workspaceId === workspace.id)!;
    expect(row.referredByName).toBe("Rosa Plumbing");
    const json = JSON.stringify(row);
    expect(json).not.toContain("rosa@gmail.com");
    expect(json).not.toContain(ref.id);
    expect(json).not.toContain("cus_ref");

    const [stored] = await database
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, ref.ownerUserId));
    const credits = JSON.stringify(await rows());
    expect(credits).not.toContain(stored!.email);
    expect(credits).not.toContain("mike@yahoo.com");
  });
});
