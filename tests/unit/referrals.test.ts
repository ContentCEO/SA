import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REFERRAL_CREDIT_CENTS, REFERRAL_CREDIT_TO } from "@/config/pricing";
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
  isPermanentStripeError,
  isReferralCode,
  isUniqueViolation,
  newReferralCode,
  PUBLIC_WEBMAIL_DOMAINS,
  referralCredit,
  referralLink,
  referralRefusal,
  referralsVisible,
  referredEmailHash,
  setReferralConfigForTests,
} from "@/server/referral-rules";
import {
  applyPendingReferralCredits,
  creditReferralOnActive,
  creditReferralSafely,
  ensureReferralCode,
  referralLinkFor,
  workspaceByReferralCode,
} from "@/server/referrals";
import { inviteFromWaitlist, joinWaitlist, waitlistInput } from "@/server/waitlist";
import { applyAdminMove } from "@/server/workspace-lifecycle";
import { createTestDb } from "../support/db";

const NOW = new Date("2026-10-12T14:00:00Z");
const CENTS = 2_500;
const ON = { FEATURE_REFERRALS: "1" };
const SECRET = "whsec_test";

// --- Fake Stripe: records calls, keeps balance transactions, never dedupes by key -----------

type Txn = {
  id: string;
  customer: string;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
};
type Call = { method: string; args: unknown[] };

let calls: Call[];
let txns: Txn[];
let failCreate: unknown;

function fakeStripe() {
  let n = 0;
  return {
    customers: {
      createBalanceTransaction: async (
        customer: string,
        params: Omit<Txn, "id" | "customer">,
        opts: unknown,
      ) => {
        calls.push({
          method: "customers.createBalanceTransaction",
          args: [customer, params, opts],
        });
        if (failCreate) throw failCreate;
        const t = { id: `cbtxn_${++n}`, customer, ...params };
        txns.push(t);
        return t;
      },
      // Like Stripe's auto-pagination: newest first, one recorded request per page.
      listBalanceTransactions: (customer: string, params?: { limit?: number }) => {
        const mine = txns.filter((t) => t.customer === customer).reverse();
        const size = params?.limit ?? 10;
        return (async function* () {
          for (let i = 0; i === 0 || i < mine.length; i += size) {
            calls.push({ method: "customers.listBalanceTransactions", args: [customer, i / size] });
            yield* mine.slice(i, i + size);
          }
        })();
      },
    },
    subscriptions: {
      cancel: async (id: string) => {
        calls.push({ method: "subscriptions.cancel", args: [id] });
        return { id };
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

const creates = () => calls.filter((c) => c.method === "customers.createBalanceTransaction");
const stripeCalls = () => calls.length;

class StripeLikeError extends Error {
  constructor(
    public readonly type: string,
    public readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = type;
  }
}

// --- Database helpers -----------------------------------------------------------------------

let database: Database;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AUTH_SECRET = "test-secret";
  process.env.APP_URL = "https://app.example";
  delete process.env.FEATURE_REFERRALS;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  database = await createTestDb();
  calls = [];
  txns = [];
  failCreate = undefined;
  setStripeForTests(fakeStripe());
  await database
    .insert(appSettings)
    .values({ key: "stripe_webhook_secret", value: encryptSecret(SECRET) });
});

afterEach(() => {
  setStripeForTests(undefined);
  setReferralConfigForTests(undefined);
  delete process.env.FEATURE_REFERRALS;
  vi.restoreAllMocks();
});

function turnOn(to: "both" | "referrer" | "referred" = "both", cents: number | null = CENTS) {
  process.env.FEATURE_REFERRALS = "1";
  setReferralConfigForTests({ cents, to });
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

/** Waitlist with the referral link → Davi's invite → first sign-in. */
async function referredViaLink(code: string, email = "mike@yahoo.com") {
  await joinWaitlist(waitlistInput.parse({ name: "Mike", email, referralCode: code }));
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

/** The full happy path: pay (setup_paid, no credit yet), then the setup call (→ active). */
async function payAndFinishSetup(referredId: string) {
  await applyCheckoutCompleted(paidSession(referredId), NOW);
  expect((await load(referredId)).status).toBe("setup_paid");
  return applyAdminMove(referredId, "mark_setup_call_done", NOW);
}

const rows = () => database.select().from(referralCredits);

// --- Pure rules -----------------------------------------------------------------------------

describe("referral rules", () => {
  it("the committed config picks no amount (ASK DAVI) and defaults to both sides", () => {
    expect(REFERRAL_CREDIT_CENTS).toBeNull();
    expect(REFERRAL_CREDIT_TO).toBe("both");
    expect(referralCredit(ON)).toBeNull();
    expect(referralsVisible(ON)).toBe(false);
  });

  it("pays nothing with the switch off, whatever the amount", () => {
    expect(referralCredit({}, CENTS, "both")).toBeNull();
    expect(referralCredit({ FEATURE_REFERRALS: "yes" }, CENTS, "both")).toBeNull();
    expect(referralsVisible({})).toBe(false);
  });

  it.each([null, 0, -500, 12.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "pays nothing with the switch on and amount %s",
    (amount) => {
      expect(referralCredit(ON, amount as number | null, "both")).toBeNull();
    },
  );

  it("pays the amount to the configured sides", () => {
    expect(referralCredit(ON, CENTS, "both")).toEqual({
      cents: CENTS,
      sides: ["referrer", "referred"],
    });
    expect(referralCredit(ON, CENTS, "referrer")?.sides).toEqual(["referrer"]);
    expect(referralCredit(ON, CENTS, "referred")?.sides).toEqual(["referred"]);
  });

  it("the test seam feeds the defaults and resets", () => {
    setReferralConfigForTests({ cents: 900, to: "referrer" });
    expect(referralCredit(ON)).toEqual({ cents: 900, sides: ["referrer"] });
    setReferralConfigForTests(undefined);
    expect(referralCredit(ON)).toBeNull();
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

  it("tells permanent Stripe refusals from ones worth retrying, and stores codes only", () => {
    expect(isPermanentStripeError({ code: "resource_missing" })).toBe(true);
    expect(isPermanentStripeError({ type: "StripeInvalidRequestError" })).toBe(true);
    expect(isPermanentStripeError({ type: "invalid_request_error" })).toBe(true);
    for (const t of ["StripeConnectionError", "StripeRateLimitError", "StripeAPIError"])
      expect(isPermanentStripeError({ type: t, code: "rate_limit" })).toBe(false);
    expect(isPermanentStripeError(null)).toBe(false);
    expect(errorCodeOf({ code: "resource_missing" })).toBe("resource_missing");
    expect(
      errorCodeOf(Object.assign(new TypeError("No such customer: cus_1"), { code: "cus_1 x" })),
    ).toBe("TypeError");
    expect(errorCodeOf("nope")).toBe("unknown");
  });

  it("describes the activity in plain words", () => {
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

describe("GATE: switched off, or no amount", () => {
  it("off: the waitlist keeps no code, nothing is carried, admin shows no referrer (A8)", async () => {
    const ref = await referrer();
    const code = await ensureReferralCode(ref.id);
    // A row saved with a code earlier (or seeded) still carries nothing while off.
    await database
      .insert(waitlist)
      .values({ email: "old@yahoo.com", name: "Old", referralCode: code });
    await joinWaitlist(
      waitlistInput.parse({ name: "Mike", email: "mike@yahoo.com", referralCode: code }),
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
    // Linked directly (say, while it was on), with a credit still waiting for the referrer.
    const { workspace: linked } = await ensureUserAndWorkspace({ email: "linked@yahoo.com" });
    await set(linked.id, { referredByWorkspaceId: ref.id });
    await database.insert(referralCredits).values({
      referredWorkspaceId: linked.id,
      referredEmailSha256: "y".repeat(64),
      beneficiaryWorkspaceId: ref.id,
      side: "referrer",
      amountCents: CENTS,
    });
    const byId = async () =>
      new Map((await adminOverview(NOW)).map((r) => [r.workspaceId, r] as const));
    const off = await byId();
    expect([...off.values()].every((r) => r.referredByName === null)).toBe(true);
    // Money still owed never disappears from /admin when the switch is off.
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

  it("off: an invite that already carries a referral isn't carried or used up", async () => {
    const ref = await referrer();
    await database
      .insert(invites)
      .values({ email: "mike@yahoo.com", referredByWorkspaceId: ref.id });
    const { workspace } = await ensureUserAndWorkspace({ email: "mike@yahoo.com" });
    expect(workspace.referredByWorkspaceId).toBeNull();
    const [inv] = await database.select().from(invites).where(eq(invites.email, "mike@yahoo.com"));
    expect(inv?.referredByWorkspaceId).toBe(ref.id);
  });

  it("off: crediting is skipped, Stripe is never called, and the sweep does nothing", async () => {
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
      amountCents: CENTS,
    });
    expect(await applyPendingReferralCredits(NOW)).toEqual({ applied: 0, settled: 0 });
    expect(stripeCalls()).toBe(0);
    expect((await rows()).map((r) => [r.status, r.amountCents]).sort()).toEqual([
      ["pending", CENTS],
      ["skipped", 0],
    ]);
  });

  it.each([null, 0, -100, 12.5])(
    "on with amount %s: nothing is credited and no money row is written",
    async (cents) => {
      turnOn("both", cents as number | null);
      expect(referralCredit()).toBeNull();
      const ref = await referrer();
      const { workspace } = await ensureUserAndWorkspace({ email: "mike@yahoo.com" });
      await set(workspace.id, {
        referredByWorkspaceId: ref.id,
        status: "active",
        setupPaidVia: "stripe",
        stripeCustomerId: "cus_new",
      });
      expect(await creditReferralOnActive(workspace.id, NOW)).toBe("skipped");
      expect(await applyPendingReferralCredits(NOW)).toEqual({ applied: 0, settled: 0 });
      const all = await rows();
      expect(all.filter((r) => r.status !== "skipped")).toHaveLength(0);
      expect(all.every((r) => r.amountCents === 0)).toBe(true);
      expect(stripeCalls()).toBe(0);
    },
  );
});

// --- The full chain -------------------------------------------------------------------------

describe("referral credit (switched on)", () => {
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
      waitlistInput.parse({ name: "B", email: "b@yahoo.com", referralCode: "<script>bad" }),
    );
    const [b] = await database.select().from(waitlist).where(eq(waitlist.email, "b@yahoo.com"));
    expect(b?.referralCode).toBeNull();
    await inviteFromWaitlist("b@yahoo.com");
    for (const email of ["a@yahoo.com", "b@yahoo.com"]) {
      const { workspace } = await ensureUserAndWorkspace({ email });
      expect(workspace.referredByWorkspaceId).toBeNull();
    }
  });

  it("credits only once active: not at setup_paid, then both sides at the setup call", async () => {
    turnOn();
    const ref = await referrer();
    const { workspace } = await referredViaLink(await ensureReferralCode(ref.id));
    await applyCheckoutCompleted(paidSession(workspace.id), NOW);
    expect(await rows()).toHaveLength(0);
    expect(stripeCalls()).toBe(0);

    expect(await applyAdminMove(workspace.id, "mark_setup_call_done", NOW)).toBe("active");
    const all = await rows();
    expect(all.map((r) => [r.side, r.status, r.amountCents]).sort()).toEqual([
      ["referred", "applied", CENTS],
      ["referrer", "applied", CENTS],
    ]);
    expect(creates()).toHaveLength(2);
    const byCustomer = Object.fromEntries(creates().map((c) => [c.args[0], c.args]));
    expect(byCustomer.cus_ref![1]).toMatchObject({ amount: -CENTS, currency: "usd" });
    expect(byCustomer.cus_ref![2]).toEqual({ idempotencyKey: `referral-${workspace.id}-referrer` });
    expect(byCustomer.cus_new![1]).toMatchObject({ amount: -CENTS, currency: "usd" });
    expect(byCustomer.cus_new![2]).toEqual({ idempotencyKey: `referral-${workspace.id}-referred` });
    for (const r of all) expect(r.stripeBalanceTransactionId).toMatch(/^cbtxn_/);
  });

  it("is paid once ever: pause/resume, re-checkout and a replayed webhook add nothing", async () => {
    turnOn();
    const ref = await referrer();
    const { workspace } = await referredViaLink(await ensureReferralCode(ref.id));
    await payAndFinishSetup(workspace.id);
    expect(creates()).toHaveLength(2);

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
    await applyPendingReferralCredits(new Date(NOW.getTime() + 86_400_000));

    expect(creates()).toHaveLength(2);
    expect(await rows()).toHaveLength(2);
  });

  it("'referrer' only credits the referrer; changing the config later adds nothing (A9)", async () => {
    turnOn("referrer");
    const ref = await referrer();
    const { workspace } = await referredViaLink(await ensureReferralCode(ref.id));
    await payAndFinishSetup(workspace.id);
    expect((await rows()).map((r) => r.side)).toEqual(["referrer"]);
    expect(creates()).toHaveLength(1);
    expect(creates()[0]!.args[0]).toBe("cus_ref");

    turnOn("both");
    await applySubscription(subscription(workspace.id, "active"), NOW);
    await applyPendingReferralCredits(NOW);
    expect((await rows()).map((r) => r.side)).toEqual(["referrer"]);
    expect(creates()).toHaveLength(1);
  });

  it("a referral that went active while off is settled as skipped and never paid later (A9)", async () => {
    turnOn();
    const ref = await referrer();
    const { workspace } = await referredViaLink(await ensureReferralCode(ref.id));
    delete process.env.FEATURE_REFERRALS;
    await payAndFinishSetup(workspace.id);
    expect((await rows()).map((r) => r.status)).toEqual(["skipped"]);

    turnOn();
    await applyPendingReferralCredits(NOW);
    await applySubscription(subscription(workspace.id, "active"), NOW);
    expect(creates()).toHaveLength(0);
    expect((await rows()).map((r) => r.status)).toEqual(["skipped"]);
  });

  it("refuses same-business-domain referrals at sign-up and at credit time", async () => {
    turnOn();
    const ref = await referrer("a@shop.com");
    const code = await ensureReferralCode(ref.id);
    const { workspace } = await referredViaLink(code, "b@shop.com");
    expect(workspace.referredByWorkspaceId).toBeNull();

    // Linked anyway (say, by an older path): the credit check refuses it too, and records
    // the decision once so the sweep never looks at it again (A9).
    await set(workspace.id, { referredByWorkspaceId: ref.id });
    await payAndFinishSetup(workspace.id);
    expect(await creditReferralOnActive(workspace.id, NOW)).toBe("skipped");
    const settled = await rows();
    expect(settled.map((r) => [r.status, r.amountCents])).toEqual([["skipped", 0]]);
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
    expect(await applyPendingReferralCredits(NOW)).toEqual({ applied: 0, settled: 0 });
    setDbForTests(database);
    // Only the sweep's own lookups (waiting rows; unsettled accounts and its NOT EXISTS
    // subquery): no owner lookups, no settlement attempt.
    expect(counted).toEqual({ select: 3, transaction: 0 });
    expect(await rows()).toEqual(settled);
    expect(stripeCalls()).toBe(0);
  });

  it("refuses self-referral (same workspace)", async () => {
    turnOn();
    const ref = await referrer();
    await set(ref.id, { referredByWorkspaceId: ref.id });
    expect(await creditReferralOnActive(ref.id, NOW)).toBe("skipped");
    expect((await rows()).map((r) => [r.status, r.amountCents])).toEqual([["skipped", 0]]);
    expect(await applyPendingReferralCredits(NOW)).toEqual({ applied: 0, settled: 0 });
    expect(await rows()).toHaveLength(1);
    expect(stripeCalls()).toBe(0);
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
      expect(creates()).toHaveLength(2);
    },
  );

  it.each([null, "house"] as const)(
    "needs a real Stripe setup payment: setup paid via %s never earns a credit (A27)",
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
      expect(await applyPendingReferralCredits(NOW)).toEqual({ applied: 0, settled: 0 });
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

  it("waits for a Stripe customer, then the sweep adds it once", async () => {
    turnOn();
    const ref = await referrer("rosa@gmail.com", { stripeCustomerId: null });
    const { workspace } = await referredViaLink(await ensureReferralCode(ref.id));
    await payAndFinishSetup(workspace.id);
    const bySide = async () => Object.fromEntries((await rows()).map((r) => [r.side, r.status]));
    expect(await bySide()).toEqual({ referrer: "pending", referred: "applied" });
    expect(creates()).toHaveLength(1);

    expect((await applyPendingReferralCredits(NOW)).applied).toBe(0);
    await set(ref.id, { stripeCustomerId: "cus_ref" });
    expect((await applyPendingReferralCredits(NOW)).applied).toBe(1);
    expect(await applyPendingReferralCredits(NOW)).toEqual({ applied: 0, settled: 0 });
    expect(await bySide()).toEqual({ referrer: "applied", referred: "applied" });
    expect(creates()).toHaveLength(2);
  });

  it("a Stripe error never fails the move or the webhook; logs ids only; the sweep retries", async () => {
    turnOn();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const ref = await referrer();
    const { workspace } = await referredViaLink(await ensureReferralCode(ref.id));
    await applyCheckoutCompleted(paidSession(workspace.id), NOW);
    failCreate = new StripeLikeError("StripeConnectionError", undefined, "cus_ref timed out");

    expect(await applyAdminMove(workspace.id, "mark_setup_call_done", NOW)).toBe("active");
    expect((await load(workspace.id)).status).toBe("active");
    const pending = await rows();
    expect(pending.map((r) => [r.status, r.attempts, r.lastErrorCode])).toEqual([
      ["pending", 1, "StripeConnectionError"],
      ["pending", 1, "StripeConnectionError"],
    ]);
    expect(errors).toHaveBeenCalled();
    for (const [event, detail] of errors.mock.calls) {
      expect(event).toBe("referral_credit_failed");
      expect(Object.keys(detail as object).sort()).toEqual(["error", "referralCreditId", "side"]);
      expect(JSON.stringify(detail)).not.toMatch(/cus_|timed out|@/);
    }

    failCreate = undefined;
    expect((await applyPendingReferralCredits(NOW)).applied).toBe(2);
    expect(txns).toHaveLength(2);
  });

  it("the webhook's move to active survives a Stripe error too", async () => {
    turnOn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ref = await referrer();
    const { workspace } = await referredViaLink(await ensureReferralCode(ref.id));
    // Setup call already done, paying now → straight to active through the webhook path.
    await set(workspace.id, { status: "canceled", setupCallCompletedAt: NOW });
    failCreate = new StripeLikeError("StripeAPIError", "api_error", "boom");
    expect(await applyCheckoutCompleted(paidSession(workspace.id), NOW)).toBe("applied");
    expect((await load(workspace.id)).status).toBe("active");
    expect((await rows()).every((r) => r.status === "pending")).toBe(true);
  });

  /** The database, except settling a referral (its transaction) throws `failures` times. */
  function settlementThrows(failures = Number.POSITIVE_INFINITY) {
    let left = failures;
    return new Proxy(database, {
      get(target, prop, receiver) {
        if (prop === "transaction" && left > 0) {
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
    expect(await applyPendingReferralCredits(NOW)).toEqual({ applied: 0, settled: 1 });
    expect(creates()).toHaveLength(2);
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
    expect(await applyPendingReferralCredits(NOW)).toEqual({ applied: 0, settled: 1 });
    setDbForTests(database);
    const settledFor = new Set((await rows()).map((r) => r.referredWorkspaceId));
    expect(settledFor.size).toBe(1);
    const missed = ids.find((id) => !settledFor.has(id))!;
    expectSettleFailedLogs(errors, [missed]);

    // Next run picks up the one that failed.
    expect(await applyPendingReferralCredits(NOW)).toEqual({ applied: 0, settled: 1 });
    expect(new Set((await rows()).map((r) => r.referredWorkspaceId))).toEqual(new Set(ids));
  });

  it("one waiting credit that throws never stops the sweep for the next (A29)", async () => {
    turnOn();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const ref = await referrer("rosa@gmail.com", { stripeCustomerId: null });
    const { workspace } = await referredViaLink(await ensureReferralCode(ref.id));
    await set(workspace.id, {
      status: "active",
      setupPaidAt: NOW,
      setupPaidVia: "stripe",
      setupCallCompletedAt: NOW,
    });
    // Nobody has a Stripe customer yet: both sides wait.
    await applyPendingReferralCredits(NOW);
    expect((await rows()).map((r) => r.status)).toEqual(["pending", "pending"]);
    await set(ref.id, { stripeCustomerId: "cus_ref" });
    await set(workspace.id, { stripeCustomerId: "cus_new" });

    // The first "mark applied" fails after Stripe added the credit.
    let failures = 1;
    setDbForTests(
      new Proxy(database, {
        get(target, prop, receiver) {
          if (prop === "update") {
            return (table: unknown) => {
              if (table === referralCredits && failures > 0) {
                failures--;
                throw new Error("cus_ref connection lost");
              }
              return target.update(table as typeof referralCredits);
            };
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      }) as Database,
    );
    expect((await applyPendingReferralCredits(NOW)).applied).toBe(1);
    setDbForTests(database);
    expect((await rows()).map((r) => r.status).sort()).toEqual(["applied", "pending"]);
    const failedCalls = errors.mock.calls.filter(([e]) => e === "referral_credit_failed");
    expect(failedCalls).toHaveLength(1);
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/cus_|@|connection lost/);

    // The next run finds Stripe's transaction by id and doesn't add a second one.
    expect((await applyPendingReferralCredits(NOW)).applied).toBe(1);
    expect(txns).toHaveLength(2);
  });

  it("/admin shows the most recent Stripe refusal's code, not an alphabetical max", async () => {
    const ref = await referrer();
    const base = {
      beneficiaryWorkspaceId: ref.id,
      side: "referrer" as const,
      amountCents: CENTS,
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

  it("a permanent Stripe refusal stops retrying and shows in /admin (A22)", async () => {
    turnOn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ref = await referrer("rosa@gmail.com", { stripeCustomerId: "cus_gone" });
    const { workspace } = await referredViaLink(await ensureReferralCode(ref.id));
    await applyCheckoutCompleted(paidSession(workspace.id), NOW);
    failCreate = new StripeLikeError(
      "StripeInvalidRequestError",
      "resource_missing",
      "No such customer: cus_gone",
    );
    await applyAdminMove(workspace.id, "mark_setup_call_done", NOW);
    expect((await rows()).map((r) => r.status)).toEqual(["failed", "failed"]);

    const before = creates().length;
    failCreate = undefined;
    await applyPendingReferralCredits(NOW);
    expect(creates()).toHaveLength(before);

    const row = (await adminOverview(NOW)).find((r) => r.workspaceId === ref.id)!;
    expect(row.referralCredits).toEqual({
      waiting: 0,
      failed: 1,
      lastErrorCode: "resource_missing",
    });
  });

  it("Stripe succeeded but our update failed: a sweep a day later doesn't credit twice (A22)", async () => {
    turnOn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ref = await referrer();
    const { workspace } = await referredViaLink(await ensureReferralCode(ref.id));
    await applyCheckoutCompleted(paidSession(workspace.id), NOW);

    // Every "mark applied" update fails once, after Stripe has already added the credit.
    let failures = 2;
    const flaky = new Proxy(database, {
      get(target, prop, receiver) {
        if (prop === "update") {
          return (table: unknown) => {
            if (table === referralCredits && failures > 0) {
              failures--;
              throw new Error("connection lost");
            }
            return target.update(table as typeof referralCredits);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Database;
    setDbForTests(flaky);
    await applyAdminMove(workspace.id, "mark_setup_call_done", NOW);
    setDbForTests(database);
    expect((await rows()).map((r) => r.status)).toEqual(["pending", "pending"]);
    expect(txns).toHaveLength(2);

    // Busy customers: 150 newer transactions push our credits past Stripe's first page.
    for (let i = 0; i < 150; i++) {
      for (const customer of ["cus_ref", "cus_new"]) {
        txns.push({
          id: `other_${customer}_${i}`,
          customer,
          amount: 100,
          currency: "usd",
          metadata: {},
        });
      }
    }
    calls = [];
    const later = new Date(NOW.getTime() + 25 * 3_600_000);
    expect((await applyPendingReferralCredits(later)).applied).toBe(2);
    expect(creates()).toHaveLength(0);
    const pages = calls.filter((c) => c.method === "customers.listBalanceTransactions");
    expect(pages.map((c) => c.args).sort()).toEqual([
      ["cus_new", 0],
      ["cus_new", 1],
      ["cus_ref", 0],
      ["cus_ref", 1],
    ]);
    const referralTxns = txns.filter((t) => t.metadata.referralCreditId);
    expect(referralTxns).toHaveLength(2);
    const all = await rows();
    expect(all.every((r) => r.status === "applied")).toBe(true);
    expect(all.map((r) => r.stripeBalanceTransactionId).sort()).toEqual(
      referralTxns.map((t) => t.id).sort(),
    );
  });

  it("the sweep settles an active referred account whose move didn't reach the credit", async () => {
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
    expect(await applyPendingReferralCredits(NOW)).toEqual({ applied: 0, settled: 1 });
    expect(creates()).toHaveLength(2);
    expect(await applyPendingReferralCredits(NOW)).toEqual({ applied: 0, settled: 0 });
    expect(creates()).toHaveLength(2);
  });

  it("survives account deletion: the same email signing up again earns nothing (A5)", async () => {
    turnOn();
    const ref = await referrer();
    const { workspace, user } = await referredViaLink(await ensureReferralCode(ref.id));
    await payAndFinishSetup(workspace.id);
    expect(creates()).toHaveLength(2);

    const connector = { revoke: async () => {} } as unknown as MailboxConnector;
    await deleteAccount(user.id, connector);
    const kept = await rows();
    expect(kept).toHaveLength(2);
    expect(kept.every((r) => r.referredWorkspaceId === null)).toBe(true);

    // Same email back: the invite's referral was used up, so nothing links them...
    const { workspace: again } = await ensureUserAndWorkspace({ email: "mike@yahoo.com" });
    expect(again.referredByWorkspaceId).toBeNull();
    // ...and even if something did, the email key says it was already paid.
    await set(again.id, { referredByWorkspaceId: ref.id });
    await payAndFinishSetup(again.id);
    await applyPendingReferralCredits(NOW);
    expect(creates()).toHaveLength(2);
    expect(await rows()).toHaveLength(2);
    // The used-up link is dropped, so the 15-minute sweep doesn't revisit it forever.
    expect((await load(again.id)).referredByWorkspaceId).toBeNull();
  });
});

// --- Privacy --------------------------------------------------------------------------------

describe("GUARDRAIL: referral data stays content-free", () => {
  it("activity detail is only {side}; admin shows the referrer's business name only", async () => {
    turnOn();
    const ref = await referrer();
    const { workspace } = await referredViaLink(await ensureReferralCode(ref.id));
    await payAndFinishSetup(workspace.id);

    const logs = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "referral_credit_applied"));
    expect(logs).toHaveLength(2);
    for (const l of logs) {
      expect(Object.keys(l.detail as object)).toEqual(["side"]);
      expect(l.actor).toBe("squared_away");
    }
    expect(logs.map((l) => l.workspaceId).sort()).toEqual([ref.id, workspace.id].sort());

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
