import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import {
  activityLog,
  appSettings,
  growthClients,
  referralCredits,
  users,
  waitlist,
  workspaces,
  type Workspace,
} from "@/db/schema";
import { encryptSecret } from "@/lib/crypto";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { applyCheckoutCompleted, setStripeForTests } from "@/server/billing";
import { growthInput, requestGrowthCall } from "@/server/growth";
import { inviteToGrowth, moveGrowthClient, startGrowth } from "@/server/growth-clients";
import { referredEmailHash, setReferralConfigForTests } from "@/server/referral-rules";
import { creditReferralOnActive, runReferralRewards } from "@/server/referrals";
import { inviteFromWaitlist, joinWaitlist, waitlistInput } from "@/server/waitlist";
import { applyAdminMove } from "@/server/workspace-lifecycle";
import { createTestDb } from "../support/db";
import { FakeStripe } from "../support/fake-stripe";

/**
 * Plan #47, Davi 2026-10-16: a Growth request can earn a referral. Someone who came through a
 * referral link and asked for a Growth call keeps the code on their waitlist row (only while
 * referrals are on); when Davi makes their account a Growth client, the referral is settled
 * once ever, under the app door's rules and the same email fingerprint.
 */

const NOW = new Date("2026-10-17T14:00:00Z");
const SECRET = "whsec_test";
const CODE = "AbCdEf123_-x";

let database: Database;
let fake: FakeStripe;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AUTH_SECRET = "test-secret";
  process.env.APP_URL = "https://app.example";
  delete process.env.FEATURE_REFERRALS;
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
});

function turnOn() {
  process.env.FEATURE_REFERRALS = "1";
  setReferralConfigForTests({ reward: "free_month_one_plan_up" });
}
function turnOff() {
  delete process.env.FEATURE_REFERRALS;
}

async function set(id: string, values: Partial<Workspace>) {
  await database.update(workspaces).set(values).where(eq(workspaces.id, id));
}

/** A paying, active referrer whose link carries CODE. */
async function referrer(email = "rosa@gmail.com", code = CODE) {
  const { workspace } = await ensureUserAndWorkspace({ email });
  await set(workspace.id, {
    status: "active",
    plan: "crew",
    setupPaidAt: NOW,
    setupPaidVia: "stripe",
    setupCallCompletedAt: NOW,
    stripeCustomerId: "cus_ref",
    referralCode: code,
  });
  return workspace.id;
}

const growthRequest = (email: string, referralCode: string | null = CODE) =>
  growthInput.parse({
    name: "Mike Torres",
    phone: "617-555-0142",
    email,
    trade: "roofing",
    services: ["google_ads", "reviews"],
    note: null,
    referralCode,
  });

/** The person's account (Davi lets them in some way; here, straight to a workspace). */
async function account(email: string) {
  return (await ensureUserAndWorkspace({ email })).workspace.id;
}

const start = (workspaceId: string) =>
  startGrowth(
    {
      workspaceId,
      services: ["reviews"],
      startedOn: "2026-10-17",
      timeZone: "America/New_York",
    },
    NOW,
  );

const rows = () => database.select().from(referralCredits);
const shape = async () =>
  (await rows()).map((r) => [r.beneficiaryWorkspaceId, r.status, r.reward, r.skipReason]);
const earned = () =>
  database.select().from(activityLog).where(eq(activityLog.action, "referral_reward_earned"));

describe("a Growth request can earn a referral (Davi, 2026-10-16)", () => {
  it("settles once when the referred person becomes a Growth client", async () => {
    turnOn();
    const rosa = await referrer();
    await requestGrowthCall(growthRequest("mike@yahoo.com"));
    const mike = await account("mike@yahoo.com");
    // Asking for a call earns nothing on its own.
    expect(await rows()).toEqual([]);

    expect(await start(mike)).toBe("started");
    expect(await shape()).toEqual([[rosa, "pending", "free_month_up", null]]);
    const [row] = await rows();
    expect(row).toMatchObject({
      referredWorkspaceId: mike,
      side: "referrer",
      referredEmailSha256: referredEmailHash("mike@yahoo.com"),
    });
    expect(await earned()).toHaveLength(1);
    expect((await earned())[0]!.workspaceId).toBe(rosa);

    // Ending and restarting Growth, and the sweep, never settle it again.
    const [client] = await database.select().from(growthClients);
    expect(await moveGrowthClient(client!.id, "end", NOW)).toBe("ok");
    expect(await start(mike)).toBe("restarted");
    await runReferralRewards(NOW);
    expect(await rows()).toHaveLength(1);
    expect(await earned()).toHaveLength(1);
  });

  it("settles when an 'Invite to Growth' first signs in (linkGrowthInvite)", async () => {
    turnOn();
    const rosa = await referrer();
    await requestGrowthCall(growthRequest("sam@yahoo.com"));
    expect(
      await inviteToGrowth({
        email: "sam@yahoo.com",
        services: ["reviews"],
        startedOn: "2026-10-17",
      }),
    ).toBe("invited");
    const sam = await account("sam@yahoo.com");
    expect(await database.select().from(growthClients)).toMatchObject([{ workspaceId: sam }]);
    expect(await shape()).toEqual([[rosa, "pending", "free_month_up", null]]);
  });

  it("the reward waits in the existing pending/apply sweep until the referrer can take it", async () => {
    turnOn();
    process.env.STRIPE_SECRET_KEY = "sk_" + "test_" + "fake";
    const rosa = await referrer();
    await set(rosa, { stripeCustomerId: null, stripeSubscriptionId: null });
    await requestGrowthCall(growthRequest("mike@yahoo.com"));
    await start(await account("mike@yahoo.com"));
    await runReferralRewards(NOW);
    // No subscription to put it on yet: it stays pending (tagged with the key's mode), with no
    // Stripe write; the engine books it once the referrer subscribes, as for an app referral.
    expect(await shape()).toEqual([[rosa, "pending", "free_month_up", null]]);
    expect((await rows())[0]!.stripeMode).toBe("test");
    expect(fake.writes).toEqual([]);
  });

  it("does nothing with the switch off: no code is kept, nothing is settled, Stripe isn't called", async () => {
    await referrer();
    await requestGrowthCall(growthRequest("mike@yahoo.com"));
    const [row] = await database.select().from(waitlist);
    expect(row!.referralCode).toBeNull();
    const mike = await account("mike@yahoo.com");
    expect(await start(mike)).toBe("started");
    await runReferralRewards(NOW);
    expect(await rows()).toEqual([]);
    expect(await earned()).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("a code kept while on, with the switch off when the client starts: never paid, then or later", async () => {
    turnOn();
    const rosa = await referrer();
    await requestGrowthCall(growthRequest("mike@yahoo.com"));
    turnOff();
    const mike = await account("mike@yahoo.com");
    await start(mike);
    // The app door's rule: settled as skipped ("off") at that moment, never given later.
    expect(await shape()).toEqual([[rosa, "skipped", "free_month_up", "off"]]);
    expect(await earned()).toEqual([]);
    expect(fake.calls).toEqual([]);
    turnOn();
    await runReferralRewards(NOW);
    expect(await shape()).toEqual([[rosa, "skipped", "free_month_up", "off"]]);
  });

  it("refuses a self-referral", async () => {
    turnOn();
    const rosa = await referrer("rosa@gmail.com");
    await requestGrowthCall(growthRequest("rosa@gmail.com"));
    await start(rosa);
    expect(await shape()).toEqual([[rosa, "skipped", "free_month_up", "self"]]);
    expect(await earned()).toEqual([]);
  });

  it("refuses a referral between two owners on the same business domain", async () => {
    turnOn();
    const boss = await referrer("boss@acme-plumbing.com");
    await requestGrowthCall(growthRequest("office@acme-plumbing.com"));
    await start(await account("office@acme-plumbing.com"));
    expect(await shape()).toEqual([[boss, "skipped", "free_month_up", "same_domain"]]);
    expect(await earned()).toEqual([]);
  });

  it("an unknown code, or a person with no Growth start, settles nothing", async () => {
    turnOn();
    await referrer();
    await requestGrowthCall(growthRequest("mike@yahoo.com", "NoSuchCode12"));
    await start(await account("mike@yahoo.com"));
    await requestGrowthCall(growthRequest("ann@yahoo.com"));
    await account("ann@yahoo.com");
    await runReferralRewards(NOW);
    expect(await rows()).toEqual([]);
  });

  it("a test-mode reward deleted by Reset test payments is settled again by the sweep", async () => {
    turnOn();
    const rosa = await referrer();
    await requestGrowthCall(growthRequest("mike@yahoo.com"));
    await start(await account("mike@yahoo.com"));
    await database.delete(referralCredits);
    await runReferralRewards(NOW);
    expect(await shape()).toEqual([[rosa, "pending", "free_month_up", null]]);
  });
});

describe("an app account and a Growth client for the same person never pay twice", () => {
  const paidSession = (workspaceId: string) =>
    ({
      id: "cs_1",
      mode: "subscription",
      payment_status: "paid",
      customer: "cus_new",
      subscription: "sub_new",
      client_reference_id: workspaceId,
      metadata: { workspaceId, plan: "solo", includesSetup: "1" },
    }) as unknown as Stripe.Checkout.Session;

  /** Waitlist with the link (app form) + a Growth request → invite → first sign-in. */
  async function referredBoth(email: string) {
    await joinWaitlist(
      waitlistInput.parse({
        name: "Mike",
        email,
        trade: "carpentry",
        teamSize: "Just me",
        referralCode: CODE,
      }),
    );
    await requestGrowthCall(growthRequest(email));
    expect(await inviteFromWaitlist(email)).toBe("invited");
    const { workspace } = await ensureUserAndWorkspace({ email });
    expect(workspace.referredByWorkspaceId).not.toBeNull();
    return workspace.id;
  }

  async function payAndFinishSetup(id: string) {
    await set(id, {
      status: "evaluating",
      evaluationStartedAt: NOW,
      evaluationEndsAt: new Date(NOW.getTime() + 3 * 86_400_000),
    });
    await applyCheckoutCompleted(paidSession(id), NOW);
    await applyAdminMove(id, "mark_setup_call_done", NOW);
  }

  it("Growth first, then the app goes active and paid: one fingerprint, one settlement", async () => {
    turnOn();
    const rosa = await referrer();
    const mike = await referredBoth("mike@yahoo.com");
    await start(mike);
    expect(await shape()).toEqual([[rosa, "pending", "free_month_up", null]]);
    await payAndFinishSetup(mike);
    expect(await creditReferralOnActive(mike, NOW)).toBe("skipped");
    await runReferralRewards(NOW);
    expect(await rows()).toHaveLength(1);
    expect(await earned()).toHaveLength(1);
  });

  it("the app first, then Growth: still one", async () => {
    turnOn();
    const rosa = await referrer();
    const mike = await referredBoth("mike@yahoo.com");
    await payAndFinishSetup(mike);
    expect(await shape()).toEqual([[rosa, "pending", "free_month_up", null]]);
    await start(mike);
    await runReferralRewards(NOW);
    expect(await rows()).toHaveLength(1);
    expect(await earned()).toHaveLength(1);
  });

  it("a deleted-and-remade account can't be paid again through Growth", async () => {
    turnOn();
    const rosa = await referrer();
    await requestGrowthCall(growthRequest("mike@yahoo.com"));
    const first = await account("mike@yahoo.com");
    await start(first);
    // The account goes (the fingerprint row stays, its workspace link cleared by the FK).
    await database.delete(users).where(eq(users.email, "mike@yahoo.com"));
    expect(await rows()).toMatchObject([{ referredWorkspaceId: null }]);
    const again = await account("mike@yahoo.com");
    await start(again);
    await runReferralRewards(NOW);
    expect(await shape()).toEqual([[rosa, "pending", "free_month_up", null]]);
    expect(await earned()).toHaveLength(1);
  });
});
