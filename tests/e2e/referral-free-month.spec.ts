import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { encryptSecret } from "../../src/lib/crypto";
import { seedOwner, setWorkspace, signInAs, testDb } from "./support";

/**
 * Plan #47 offer A, what the owner sees (design §4, §5.4). Rows are seeded straight into the
 * database: the e2e server has no Stripe key and no FEATURE_REFERRALS, and a booked or running
 * free month shows either way (Stripe already holds the coupon). The share card itself only
 * shows with the switch on, so its per-plan copy is covered by referral-rules.test.ts.
 */

const DAY = 86_400_000;
const short = (d: Date) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  }).format(d);

type Setup = {
  status?: "active" | "setup_paid";
  plan?: "solo" | "crew" | "company";
  free?: "crew" | "company";
  untilMs?: number;
  kept?: boolean;
};

/** An owner on a paid plan with a running free month (and its reward row). */
async function seedFreeMonth(opts: Setup = {}) {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  const plan = opts.plan ?? "solo";
  const free = opts.free ?? "crew";
  const until = new Date(Date.now() + (opts.untilMs ?? 10 * DAY));
  await setWorkspace(owner.workspaceId, {
    status: opts.status ?? "active",
    plan,
    setupPaidAt: new Date(),
    setupPaidVia: "stripe",
    setupCallCompletedAt: opts.status === "setup_paid" ? null : new Date(),
    stripeCustomerId: `cus_${randomUUID().slice(0, 8)}`,
    stripeSubscriptionId: `sub_${randomUUID().slice(0, 8)}`,
    freePlan: free,
    freePlanUntil: until,
  });
  const paidPlan = opts.kept ? "solo" : plan;
  const [row] = await testDb
    .insert(schema.referralCredits)
    .values({
      referredEmailSha256: `e2e-${randomUUID()}`,
      beneficiaryWorkspaceId: owner.workspaceId,
      side: "referrer",
      amountCents: 0,
      reward: "free_month_up",
      status: "running",
      stripeMode: "test",
      paidPlan,
      paidPriceId: `price_${paidPlan}`,
      paidPriceCents: paidPlan === "solo" ? 9_900 : paidPlan === "crew" ? 19_900 : 29_900,
      freePlan: free,
      startsAt: new Date(Date.now() - 5 * DAY),
      endsAt: until,
      keptAt: opts.kept ? new Date() : null,
      keptPriceCents: opts.kept ? 19_900 : null,
    })
    .returning();
  return { owner, until, rewardId: row!.id };
}

test("a running free month: the banner on every screen links to Keep", async ({
  page,
  context,
}) => {
  const { owner, until } = await seedFreeMonth();
  await signInAs(context, owner);
  await page.goto("/queue");
  const banner = page.getByRole("region", { name: "Your free month" });
  await expect(banner).toContainText(
    `You're on Crew free until ${short(until)} — then back to Solo.`,
  );
  const link = banner.getByRole("link", { name: "Keep Crew?" });
  const box = await link.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await link.click();
  await expect(page).toHaveURL(/\/billing#free-month$/);
  const section = page.getByRole("region", { name: "Your free month" }).last();
  await expect(section).toContainText(
    `You're on Crew free until ${short(until)}. Then you go back to Solo at $99 a month.`,
  );
  // What's billed stays the heading; the free plan is a line under it.
  const current = page.getByRole("region", { name: /Solo · \$99/ });
  await expect(current).toContainText(
    `Crew is free until ${short(until)}, our thanks for the referral.`,
  );
  await expect(current).toContainText("Stripe's page shows Solo, the plan you pay for.");
});

test("setup paid and a free month: both cards show", async ({ page, context }) => {
  const { owner } = await seedFreeMonth({ status: "setup_paid" });
  await signInAs(context, owner);
  await page.goto("/queue");
  await expect(page.getByText("Setup's paid. Sending is on.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Your free month" })).toContainText(
    "then back to Solo",
  );
});

test("three days before the end, the banner says what will change", async ({ page, context }) => {
  const { owner, until } = await seedFreeMonth({ untilMs: 2 * DAY });
  await testDb
    .insert(schema.rules)
    .values({ workspaceId: owner.workspaceId, category: "scheduling", mode: "autopilot" });
  await testDb.insert(schema.mailboxes).values({
    workspaceId: owner.workspaceId,
    email: `second-${randomUUID().slice(0, 6)}@example.com`,
    encryptedRefreshToken: encryptSecret("fake-refresh-token"),
    scopes: "gmail",
    status: "active",
  });
  await signInAs(context, owner);
  await page.goto("/queue");
  await expect(page.getByRole("region", { name: "Your free month" })).toContainText(
    `You're on Crew free until ${short(until)} — then back to Solo: 1 inbox pauses and autopilot turns off.`,
  );
});

test("Keep: the confirm names the price and the date; without Stripe nothing changes", async ({
  page,
  context,
}) => {
  const { owner, until, rewardId } = await seedFreeMonth();
  await signInAs(context, owner);
  await page.goto("/billing#free-month");
  await page.getByRole("button", { name: "Keep Crew" }).click();
  const confirm = page.getByRole("form", { name: `Keep Crew after ${short(until)}?` });
  await expect(confirm).toContainText(
    `Crew is $199 a month, plus sales tax where it applies. That's $100 more than you pay now. Your first Crew payment is on ${short(until)}. Nothing is charged today.`,
  );
  const yes = confirm.getByRole("button", { name: "Yes, keep Crew at $199 a month" });
  expect((await yes.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await yes.click();
  await expect(page.getByText("Online payment isn't switched on yet.")).toBeVisible();
  const [row] = await testDb
    .select()
    .from(schema.referralCredits)
    .where(eq(schema.referralCredits.id, rewardId));
  expect(row!.keptAt).toBeNull();
  expect(row!.planChangeSeq).toBe(0);
  const [w] = await testDb
    .select({ plan: schema.workspaces.plan })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, owner.workspaceId));
  expect(w!.plan).toBe("solo");
});

test("kept: the banner says what Crew costs from the end, and offers Go back", async ({
  page,
  context,
}) => {
  const { owner, until } = await seedFreeMonth({ plan: "crew", kept: true });
  await signInAs(context, owner);
  await page.goto("/billing");
  await expect(page.getByRole("region", { name: "Your free month" }).first()).toContainText(
    `You're on Crew free until ${short(until)}. Then Crew is $199 a month.`,
  );
  await expect(page.getByText("Changed your mind?")).toBeVisible();
  await page.getByRole("button", { name: `Go back to Solo after ${short(until)}` }).click();
  await expect(
    page.getByRole("form", { name: `Go back to Solo after ${short(until)}?` }),
  ).toContainText("You'll pay $99 a month again, as before.");
});

test("Company to Company: a free month with nothing to keep", async ({ page, context }) => {
  const { owner, until } = await seedFreeMonth({ plan: "company", free: "company" });
  await signInAs(context, owner);
  await page.goto("/billing");
  await expect(page.getByRole("region", { name: "Your free month" }).first()).toContainText(
    `This month's free, thanks for the referral. Company renews ${short(until)}.`,
  );
  await expect(page.getByRole("button", { name: /^Keep / })).toHaveCount(0);
  await expect(page.getByText("Stripe's page shows")).toHaveCount(0);
});

test("after the free month ends: no banner, even before any job runs", async ({
  page,
  context,
}) => {
  const { owner } = await seedFreeMonth({ untilMs: -DAY });
  await signInAs(context, owner);
  await page.goto("/queue");
  await expect(page.getByRole("region", { name: "Your free month" })).toHaveCount(0);
  await page.goto("/billing");
  await expect(page.getByRole("region", { name: "Your free month" })).toHaveCount(0);
  await expect(page.getByText(/free until/)).toHaveCount(0);
});

test("a paused inbox: Settings says why and offers the switch; the queue says replies wait", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, {
    status: "active",
    plan: "solo",
    setupPaidAt: new Date(),
    setupPaidVia: "stripe",
    setupCallCompletedAt: new Date(),
  });
  const [paused] = await testDb
    .insert(schema.mailboxes)
    .values({
      workspaceId: owner.workspaceId,
      email: `paused-${randomUUID().slice(0, 6)}@example.com`,
      encryptedRefreshToken: encryptSecret("fake-refresh-token"),
      scopes: "gmail",
      status: "paused",
      pausedReason: "over_plan",
      backfillCompletedAt: new Date(),
    })
    .returning();
  const [t] = await testDb
    .insert(schema.threads)
    .values({
      mailboxId: paused!.id,
      gmailThreadId: `t-${paused!.id}`,
      inInbox: true,
      category: "quote_request",
      lastMessageAt: new Date(),
    })
    .returning();
  const [m] = await testDb
    .insert(schema.messages)
    .values({
      threadId: t!.id,
      mailboxId: paused!.id,
      gmailMessageId: `m-${paused!.id}`,
      direction: "in",
      fromName: "Rosa",
      fromAddress: "rosa@x.com",
      sentAt: new Date(),
    })
    .returning();
  await testDb.insert(schema.drafts).values({
    threadId: t!.id,
    mailboxId: paused!.id,
    replyToMessageId: m!.id,
    gmailDraftId: "fake-paused-draft",
    toAddress: "rosa@x.com",
    subject: "Re: Deck",
    body: "Hi Rosa, thanks.",
    originalBody: "same",
    reason: "Quote request.",
    confidence: 85,
  });
  await signInAs(context, owner);

  await page.goto("/queue");
  await expect(
    page.getByText(
      "1 reply is waiting in a paused inbox. Solo includes 1 inbox. It's still in that inbox's Gmail drafts.",
    ),
  ).toBeVisible();

  await page.goto("/settings/gmail");
  await expect(
    page.getByText(
      "Paused. Solo includes 1 inbox. Nothing is read or drafted here, and nothing was deleted.",
    ),
  ).toBeVisible();
  const swap = page.getByText("Switch this one on instead", { exact: true });
  await expect(swap).toBeVisible();
  expect((await swap.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await swap.click();
  await expect(page.getByRole("button", { name: "Switch inboxes" })).toBeVisible();
});
