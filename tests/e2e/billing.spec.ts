import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedAdmin, seedOwner, setWorkspace, signInAs, testDb } from "./support";

const DAY = 86_400_000;

// The e2e server runs without STRIPE_SECRET_KEY: payment stays off and says so.

test("expired trial: the banner leads to plans, and /billing explains how to pay", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, {
    status: "evaluating",
    evaluationStartedAt: new Date(Date.now() - 4 * DAY),
    evaluationEndsAt: new Date(Date.now() - DAY),
  });
  await signInAs(context, owner);

  await page.goto("/queue");
  const banner = page.getByRole("status").filter({ hasText: "Your three days are up." });
  await banner.getByRole("link", { name: "Choose a plan" }).click();
  await expect(page).toHaveURL(/\/billing$/);
  await expect(page.getByText("Online payment isn't switched on yet")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Choose / })).toHaveCount(0);
});

test("during the trial the clock links to plans", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, {
    status: "evaluating",
    evaluationStartedAt: new Date(),
    evaluationEndsAt: new Date(Date.now() + 3 * DAY),
  });
  await signInAs(context, owner);
  await page.goto("/queue");
  await page
    .getByRole("region", { name: "Your three days" })
    .getByRole("link", { name: "See plans" })
    .click();
  await expect(page).toHaveURL(/\/billing$/);
});

test("a paying account sees its plan and the way to manage it", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, {
    status: "active",
    plan: "crew",
    setupPaidAt: new Date(),
    setupPaidVia: "stripe",
    setupCallCompletedAt: new Date(),
    stripeCustomerId: "cus_e2e",
    stripeSubscriptionId: "sub_e2e",
  });
  await signInAs(context, owner);
  await page.goto("/settings");
  await page.getByRole("link", { name: "Plan & billing" }).click();
  await expect(page.getByRole("heading", { name: /Crew · \$199/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Manage billing" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Choose / })).toHaveCount(0);
  // Plan #47 is off (no FEATURE_REFERRALS, no amount): no referral link and no code made.
  await expect(page.getByRole("region", { name: "Share Squared Away" })).toHaveCount(0);
  await expect(page.getByText(/referral|\?ref=/i)).toHaveCount(0);
  const [w] = await testDb
    .select({ code: schema.workspaces.referralCode })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, owner.workspaceId));
  expect(w?.code).toBeNull();
});

test("past due: the banner says update payment", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, {
    status: "past_due",
    plan: "solo",
    stripeCustomerId: "cus_e2e2",
  });
  await signInAs(context, owner);
  await page.goto("/queue");
  await expect(page.getByRole("link", { name: "Update payment" })).toHaveAttribute(
    "href",
    "/billing",
  );
});

test("the Stripe webhook refuses unsigned requests", async ({ request }) => {
  const res = await request.post("/api/stripe/webhook", {
    data: { id: "evt_x", type: "checkout.session.completed" },
  });
  expect(res.status()).toBe(400);
});

test("admin: Payments section explains what's missing", async ({ page, context }) => {
  const admin = await seedAdmin();
  await signInAs(context, admin);
  await page.goto("/admin");
  const payments = page.getByRole("region", { name: "Payments" });
  await expect(payments).toContainText("STRIPE_SECRET_KEY");
});

test("marked paid without a real payment: sending stays off and it says how to fix it", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  // Also what "Reset test payments" leaves: status and plan kept, no real payment, no Stripe ids.
  await setWorkspace(owner.workspaceId, {
    status: "active",
    plan: "crew",
    setupPaidAt: new Date(),
  });
  await signInAs(context, owner);
  await page.goto("/queue");
  const banner = page
    .getByRole("status")
    .filter({ hasText: "Sending turns on once setup is paid." });
  await expect(banner.getByRole("link", { name: "Choose a plan" })).toHaveAttribute(
    "href",
    "/billing",
  );
  // The page the banner sends them to says the same, never "Setup's paid" or "renews monthly".
  await banner.getByRole("link", { name: "Choose a plan" }).click();
  await expect(page).toHaveURL(/\/billing$/);
  const current = page.getByRole("region", { name: /Crew · \$199/ });
  await expect(current).toContainText("Sending turns on once your setup payment goes through.");
  await expect(current).not.toContainText(/renews monthly|Setup.s paid/);
  // No Stripe customer, so no Manage billing and no sentence about Stripe's page.
  await expect(page.getByRole("button", { name: "Manage billing" })).toHaveCount(0);
  await expect(page.getByText(/Stripe.s secure page/)).toHaveCount(0);
});
