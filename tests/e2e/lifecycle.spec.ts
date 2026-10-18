import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { seedAdmin, seedOwner, seedQueue, setWorkspace, signInAs, testDb } from "./support";

const DAY = 86_400_000;

test("during the three days: the clock is on every screen and sending is off", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  const now = Date.now();
  await setWorkspace(owner.workspaceId, {
    status: "evaluating",
    evaluationStartedAt: new Date(now - DAY / 2),
    evaluationEndsAt: new Date(now + 2.5 * DAY),
  });
  await signInAs(context, owner);

  await page.goto("/queue");
  const clock = page.getByRole("region", { name: "Your three days" });
  await expect(clock).toContainText("Day 1 of 3");
  await expect(clock).toContainText("2 days");
  const card = page.getByRole("article", { name: "Draft reply to Priya" });
  await expect(card.getByRole("note")).toContainText("Send reply is off during your three days");
  await expect(card.getByRole("button", { name: "Edit" })).toBeVisible();

  await page.goto("/inbox");
  await expect(page.getByRole("region", { name: "Your three days" })).toBeVisible();
});

test("after the three days: read-only, and it says why", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  // The clock ran out but no job has recorded it yet — the screen must still know.
  await setWorkspace(owner.workspaceId, {
    status: "evaluating",
    evaluationStartedAt: new Date(Date.now() - 4 * DAY),
    evaluationEndsAt: new Date(Date.now() - DAY),
  });
  await signInAs(context, owner);

  await page.goto("/queue");
  const banner = page.getByRole("status").filter({ hasText: "Your three days are up." });
  await expect(banner).toContainText("read-only");
  await expect(banner.getByRole("link", { name: "978-201-9763" })).toBeVisible();
  await expect(page.getByText("Customer says the leak came back.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Draft a reply" })).toHaveCount(0);

  const card = page.getByRole("article", { name: "Draft reply to Priya" });
  await expect(card).toContainText("Asked for the address and panel age.");
  await expect(card.getByRole("note")).toContainText("Sending turns on once you choose a plan");
  await expect(card.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Discard" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Send reply" })).toHaveCount(0);
});

test("/admin is invisible to owners", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true });
  await signInAs(context, owner);
  const res = await page.goto("/admin");
  expect(res?.status()).toBe(404);
  await page.goto("/settings");
  await expect(page.getByRole("link", { name: /^Admin/ })).toHaveCount(0);
  await page.goto("/more");
  await expect(page.getByRole("link", { name: /^Admin/ })).toHaveCount(0);
});

test("admin: sees health with no email content, and can turn sending on", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await seedQueue(owner.mailboxId!);
  await setWorkspace(owner.workspaceId, {
    status: "evaluating",
    businessName: "Leak Busters",
    evaluationStartedAt: new Date(),
    evaluationEndsAt: new Date(Date.now() + 3 * DAY),
  });
  const admin = await seedAdmin();
  await signInAs(context, admin);

  await page.goto("/more");
  await page.getByRole("link", { name: /^Admin/ }).click();
  await expect(page).toHaveURL(/\/admin$/);

  const card = page.getByRole("article", { name: owner.email });
  await expect(card).toContainText("Leak Busters");
  await expect(card).toContainText("Evaluating");
  await expect(card).toContainText("Drafts waiting");
  // No customer names, summaries or draft text on the admin page.
  for (const secret of ["Priya", "Dana", "leak came back", "panel age"]) {
    await expect(page.locator("main")).not.toContainText(secret);
  }

  // Only a real Stripe payment turns sending on: no admin button can do it for a customer.
  await expect(card).toContainText("Not yet");
  await expect(card.getByText("Mark setup paid")).toHaveCount(0);
  await expect(card.getByText("Use as my own test account")).toHaveCount(0);

  // Davi's own card (always pinned first) has the test-account switch.
  await testDb
    .update(schema.workspaces)
    .set({ setupPaidVia: null })
    .where(eq(schema.workspaces.ownerUserId, admin.userId));
  await page.reload();
  const mine = page.getByRole("article", { name: admin.email });
  await mine.getByText("Use as my own test account").click();
  await mine.getByRole("button", { name: "Yes, this is my account" }).click();
  await expect(page.getByText("Your account can send now")).toBeVisible();
  await expect(page.getByRole("article", { name: admin.email })).toContainText(
    "Your own test account",
  );

  const [w] = await testDb
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, owner.workspaceId));
  expect(w!.status).toBe("evaluating");
  expect(w!.setupPaidVia).toBeNull();
});

test("admin: one stuck inbox inverts the System box and its card (Check 16 P1)", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, { status: "active", businessName: "Stale Pipes" });
  await testDb
    .update(schema.mailboxes)
    .set({
      lastSyncedAt: new Date(Date.now() - 6 * 3_600_000),
      lastSyncErrorCode: "sync_failed",
      lastSyncErrorAt: new Date(),
    })
    .where(eq(schema.mailboxes.id, owner.mailboxId!));
  const admin = await seedAdmin();
  await signInAs(context, admin);
  await page.goto("/admin");

  const system = page.getByRole("region", { name: /System|stuck|stopped/ });
  await expect(system).toContainText(/ha(s|ve)n't been checked for over 30 minutes/);
  const card = page.getByRole("article", { name: owner.email });
  await expect(card).toContainText("Stuck");
  await expect(card).toContainText("not checked for 6 hours");
  await expect(card).toContainText("checks failing");
  await expect(card).not.toContainText("healthy");
});

test("admin: an invited owner's card has no Give 3 more days (Check 16 P2)", async ({
  page,
  context,
}) => {
  const invited = await seedOwner();
  const admin = await seedAdmin();
  await signInAs(context, admin);
  await page.goto("/admin");
  const card = page.getByRole("article", { name: invited.email });
  await expect(card).toContainText("Invited");
  await expect(card.getByText("Give 3 more days")).toHaveCount(0);
});

test("admin: invite an owner", async ({ page, context }) => {
  const admin = await seedAdmin();
  await signInAs(context, admin);
  const email = `new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;

  await page.goto("/admin");
  await page.getByLabel("Their Gmail address").fill(email);
  await page.getByLabel("Trade").selectOption("electrical");
  await page.getByRole("button", { name: "Add to invite list" }).click();
  await page.waitForURL(/done=invited/);
  await expect(page.getByText("Invited. They can sign in now")).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  // Round 2 (FW A4): the Google test-user reminder, ticked off by hand.
  const item = page.getByRole("listitem").filter({ hasText: email });
  await expect(item).toContainText("Add them as a Google test user");
  await item.getByRole("button", { name: "I added them" }).click();
  await page.waitForURL(/done=test_user/);
  await expect(page.getByRole("listitem").filter({ hasText: email })).toContainText(
    "Google test user: added",
  );

  const [row] = await testDb.select().from(schema.invites).where(eq(schema.invites.email, email));
  expect(row?.trade).toBe("electrical");
});

test("during the three days, the only send on offer is a practice copy to yourself", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, {
    status: "evaluating",
    evaluationStartedAt: new Date(),
    evaluationEndsAt: new Date(Date.now() + 2 * 86_400_000),
  });
  await seedQueue(owner.mailboxId!);
  await signInAs(context, owner);
  await page.goto("/queue");
  const card = page.getByRole("article", { name: "Draft reply to Priya" });
  await expect(card.getByRole("button", { name: "Send reply" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Send it to yourself instead" })).toBeVisible();
  await expect(card).toContainText("Your customer gets nothing. 10 left.");
});

test("AI costs: admin only", async ({ page, context }) => {
  const owner = await seedOwner({ mailbox: true });
  await signInAs(context, owner);
  expect((await page.goto("/admin/costs"))?.status()).toBe(404);

  const admin = await seedAdmin();
  await context.clearCookies();
  await signInAs(context, admin);
  await page.goto("/admin");
  await page.getByRole("link", { name: "AI costs and margins this month" }).click();
  await expect(page.getByRole("heading", { name: /AI costs/ })).toBeVisible();
  await expect(page.getByRole("list", { name: "Accounts by margin" })).toBeVisible();
});

test("paused with a Stripe plan: the owner is told billing hasn't changed, and Davi sees it (Check 17 P2)", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, {
    status: "paused",
    pausedFrom: "active",
    plan: "crew",
    businessName: "Billed While Paused",
    setupPaidAt: new Date(),
    setupPaidVia: "stripe",
    stripeCustomerId: "cus_e2e_paused",
    stripeSubscriptionId: "sub_e2e_paused",
  });
  await signInAs(context, owner);
  await page.goto("/queue");
  const banner = page.getByRole("status").filter({ hasText: "Your account is paused." });
  await expect(banner).toContainText("Your plan's billing hasn't changed.");

  const admin = await seedAdmin();
  await context.clearCookies();
  await signInAs(context, admin);
  await page.goto("/admin");
  const card = page.getByRole("article", { name: owner.email });
  await expect(card).toContainText("Still billed in Stripe");
  await expect(card).not.toContainText("sub_e2e_paused");
});

test("pausing a paying account warns that Stripe keeps charging (Check 17 P2)", async ({
  page,
  context,
}) => {
  const owner = await seedOwner({ mailbox: true, backfilled: true });
  await setWorkspace(owner.workspaceId, {
    status: "active",
    plan: "solo",
    setupPaidAt: new Date(),
    setupPaidVia: "stripe",
    stripeSubscriptionId: "sub_e2e_pausing",
  });
  const admin = await seedAdmin();
  await signInAs(context, admin);
  await page.goto("/admin");
  const card = page.getByRole("article", { name: owner.email });
  await card.getByText("Pause account").click();
  await expect(card).toContainText("Their Stripe plan keeps charging.");
});
