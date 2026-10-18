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
  // Check 17 P11: the prices are readable even while online payment is off.
  await expect(page.getByRole("listitem", { name: "Solo plan" })).toContainText("$99");
  await expect(page.getByText("$499")).toBeVisible();
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
  // Check 17 P3: the portal button names what they came for.
  await page.goto("/billing");
  await expect(page.getByRole("button", { name: "Update card" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Manage billing" })).toHaveCount(0);
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

test("a canceled plan still running shows its end date, not 'renews monthly' (Check 17 P3)", async ({
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
    stripeCustomerId: "cus_e2e_ending",
    stripeSubscriptionId: "sub_e2e_ending",
    planEndsAt: new Date(Date.now() + 3 * DAY),
  });
  await signInAs(context, owner);
  await page.goto("/billing");
  await expect(
    page.getByText(/^Your plan ends on [A-Z][a-z]{2} \d{1,2}\. Nothing is deleted\./),
  ).toBeVisible();
  await expect(page.getByText("renews monthly")).toHaveCount(0);
  // The last week: a quiet reminder on every screen.
  await page.goto("/queue");
  await expect(page.getByRole("status").filter({ hasText: /Your plan ends on/ })).toBeVisible();
});

test("paid but no Stripe notice: the page stops waiting and says what happens next (Check 17 P9)", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, {
    status: "evaluating",
    evaluationStartedAt: new Date(),
    evaluationEndsAt: new Date(Date.now() + 2 * DAY),
  });
  await signInAs(context, owner);
  await page.goto("/billing?done=paid&session_id=cs_test_e2e");
  await expect(page.getByText("Payment received — finishing up.")).toBeVisible();
  // e2e mode refreshes 3 times, 300ms apart, then gives up.
  await expect(
    page.getByText(/Stripe has your payment, but our side hasn't caught up yet/),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("link", { name: /\d{3}-\d{3}-\d{4}/ }).first()).toBeVisible();
  // Davi sees it on /admin (recorded by the page's server action).
  await expect
    .poll(async () => {
      const rows = await testDb
        .select()
        .from(schema.appSettings)
        .where(eq(schema.appSettings.key, `stripe-ws:waiting:${owner.workspaceId}`));
      return rows[0]?.value ?? null;
    })
    .toBe("cs_test_e2e");
});

test("Davi's house account: no plan cards and no 'renews monthly' (Check 17 P11)", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, {
    status: "setup_paid",
    plan: "crew",
    setupPaidAt: new Date(),
    setupPaidVia: "house",
  });
  await signInAs(context, owner);
  await page.goto("/billing");
  await expect(page.getByText("Your own test account. Nothing is billed.")).toBeVisible();
  await expect(page.getByText("renews monthly")).toHaveCount(0);
  await expect(page.getByRole("listitem", { name: /plan$/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "What happens next" })).toHaveCount(0);
});
